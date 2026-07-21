import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UserSheriffConfig } from '../../core/src/lib/config/user-sheriff-config';
import { generateOracle } from '../../core/src/tools/engine-oracle';
import type { EngineOracle } from '../../core/src/tools/engine-oracle';
import {
  createOracleFixture,
  oracleFixtures,
} from '../../core/src/tools/tests/oracle-fixtures';
import type { EngineErrorOutput, EngineInput, EngineOutput } from '../index.js';

const require = createRequire(import.meta.url);
const { analyzeProject, EngineImpureCallbackError, ProjectHandle } =
  require('../index.js') as typeof import('../index.js');
const { nativeBinaryName } = require('../platform.js') as {
  nativeBinaryName: () => string;
};
const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nativePath = path.join(packageDir, 'native', nativeBinaryName());
const nativeRequested = process.env.SHERIFF_ENGINE_NATIVE === '1';
const nativeAvailable = existsSync(nativePath);
const nativeEnabled = nativeRequested && nativeAvailable;
const nativeSkipReason = nativeRequested
  ? `native artefact absent at ${nativePath}`
  : 'SHERIFF_ENGINE_NATIVE is not set to 1';

reportScenarioPlan();

describe
  .skipIf(!nativeEnabled)
  .sequential(
    `sheriff Rust engine conformance${nativeEnabled ? '' : ` — ${nativeSkipReason}`}`,
    () => {
      for (const fixture of oracleFixtures) {
        it(fixture.name, () => {
          createOracleFixture(fixture);
          const oracle = generateOracle(fixture.entry);
          const input = createEngineInput(oracle, fixture.config);
          const output = JSON.parse(analyzeProject(input)) as
            | EngineOutput
            | EngineErrorOutput;

          expect(output).not.toHaveProperty('error');
          if ('error' in output) return;

          expect({
            modules: output.modules,
            violations: output.violations,
          }).toEqual({
            modules: oracle.modules,
            violations: oracle.violations,
          });
        });
      }
    },
  );

describe.skipIf(!nativeEnabled)('function materialisation protocol', () => {
  it('AND-combines matching external rule keys and passes the narrow context', () => {
    const output = analyze({
      ...baseInput(),
      files: [
        {
          path: 'src/source/entry.ts',
          imports: [{ raw: 'library', kind: 'external' }],
        },
      ],
      modulePaths: [{ path: 'src/source', isBarrel: false }],
      moduleConfig: { 'src/source': 'source' },
      depRules: { source: '*' },
      externalRules: {
        's*': (context) =>
          !('to' in context) &&
          context.fromModulePath === '/project/src/source' &&
          context.fromFilePath === '/project/src/source/entry.ts',
        source: () => false,
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.external).toEqual([
      {
        file: 'src/source/entry.ts',
        externalLibrary: 'library',
        fromTag: 'source',
      },
    ]);
  });

  it('materialises per-file decisions for different files in one module', () => {
    const output = analyze({
      ...baseInput(),
      files: [
        {
          path: 'src/source/allowed.ts',
          imports: [
            {
              raw: '../target/entry.ts',
              kind: 'module',
              resolvedPath: 'src/target/entry.ts',
            },
          ],
        },
        {
          path: 'src/source/blocked.ts',
          imports: [
            {
              raw: '../target/entry.ts',
              kind: 'module',
              resolvedPath: 'src/target/entry.ts',
            },
          ],
        },
        { path: 'src/target/entry.ts', imports: [] },
      ],
      modulePaths: [
        { path: 'src/source', isBarrel: false },
        { path: 'src/target', isBarrel: false },
      ],
      moduleConfig: { 'src/source': 'source', 'src/target': 'target' },
      depRules: {
        source: ({ fromFilePath }) => fromFilePath.endsWith('/allowed.ts'),
        target: [],
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.dependency).toHaveLength(1);
    expect(output.violations.dependency[0]?.file).toBe('src/source/blocked.ts');
  });

  it('passes absolute paths in dependency callback contexts', () => {
    const output = analyze({
      ...dependencyInput(),
      depRules: {
        source: ({
          fromModulePath,
          toModulePath,
          fromFilePath,
          toFilePath,
        }) =>
          fromModulePath === '/project/src/source' &&
          toModulePath === '/project/src/target' &&
          fromFilePath === '/project/src/source/entry.ts' &&
          toFilePath === '/project/src/target/entry.ts',
        target: [],
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.dependency).toEqual([]);
  });

  it('serializes dependency callback properties in TypeScript insertion order', () => {
    const output = JSON.parse(
      analyzeProject(
        JSON.stringify({
          ...dependencyInput(),
          depRules: {
            source: { __sheriffEngineCallbackId: 0 },
            target: [],
          },
        }),
      ),
    ) as {
      ruleCallbackCandidates: Array<{ context: Record<string, unknown> }>;
    };

    expect(Object.keys(output.ruleCallbackCandidates[0]?.context ?? {})).toEqual(
      [
        'fromModulePath',
        'toModulePath',
        'fromFilePath',
        'toFilePath',
        'fromTags',
        'toTags',
        'from',
        'to',
      ],
    );
  });

  it('passes accumulated placeholders and the final regex matcher context to tag functions', () => {
    const output = analyze({
      ...baseInput(),
      files: [{ path: 'src/customers/feature/entry.ts', imports: [] }],
      modulePaths: [{ path: 'src/customers/feature', isBarrel: false }],
      moduleConfig: {
        'src/<domain>': {
          '/(feature)/': (placeholders, { segment, regexMatch }) => [
            `domain:${placeholders.domain}`,
            `segment:${segment}`,
            `capture:${regexMatch?.[1]}`,
          ],
        },
      },
      depRules: { '*': '*' },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.modules).toContainEqual({
      path: 'src/customers/feature',
      tags: ['capture:feature', 'domain:customers', 'segment:feature'],
      isBarrel: false,
    });
  });

  it('rejects an obviously stateful callback before it can be batched', () => {
    let calls = 0;
    const input: EngineInput = {
      ...dependencyInput(),
      depRules: {
        source: () => calls++ % 2 === 0,
        target: [],
      },
    };

    expect(() => analyzeProject(input)).toThrow(EngineImpureCallbackError);
    expect(calls).toBe(0);
  });

  it('rejects callbacks that close over helper functions before invoking them', () => {
    const calls: number[] = [];
    const bump = () => calls.push(1);
    const input: EngineInput = {
      ...dependencyInput(),
      depRules: {
        source: ({ toFilePath }) => (bump(), toFilePath.startsWith('/')),
        target: [],
      },
    };

    expect(() => analyzeProject(input)).toThrow(EngineImpureCallbackError);
    expect(calls).toEqual([]);
  });

  it('evaluates each materialized callback exactly once per candidate', () => {
    const output = analyze({
      ...dependencyInput(),
      depRules: {
        source: (context) => (
          context.fromTags.push('seen'), context.fromTags.length === 2
        ),
        target: [],
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.dependency).toEqual([]);
  });

  it('accepts nested parameters, property keys, and string literals as non-free identifiers', () => {
    const output = analyze({
      ...dependencyInput(),
      depRules: {
        source: ({ toTags }) =>
          toTags.some((tag) => ({ value: tag, label: 'tag' }).value === tag),
        target: [],
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.dependency).toEqual([]);
  });

  it('does not materialize dependency callbacks after a matching string', () => {
    const output = analyze({
      ...dependencyInput(),
      depRules: {
        source: [
          'target',
          () => {
            throw new Error('UNREACHABLE');
          },
        ],
        target: [],
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.dependency).toEqual([]);
  });

  it('does not materialize deny callbacks after a matching string', () => {
    const output = analyze({
      ...dependencyInput(),
      depRules: { source: 'target', target: [] },
      denyRules: {
        source: [
          'target',
          () => {
            throw new Error('UNREACHABLE');
          },
        ],
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.dependency).toEqual([
      expect.objectContaining({ cause: 'deny-rule' }),
    ]);
  });

  it('does not materialize external callbacks after a statically denying key', () => {
    const output = analyze({
      ...baseInput(),
      files: [
        {
          path: 'src/source/entry.ts',
          imports: [{ raw: 'library', kind: 'external' }],
        },
      ],
      modulePaths: [{ path: 'src/source', isBarrel: false }],
      moduleConfig: { 'src/source': 'source' },
      depRules: { source: '*' },
      externalRules: {
        source: [],
        's*': () => {
          throw new Error('UNREACHABLE');
        },
      },
    });

    expect(output).not.toHaveProperty('error');
    if ('error' in output) return;
    expect(output.violations.external).toHaveLength(1);
  });

  it('still reports SH-002 when no from key matches', () => {
    const output = analyze({
      ...baseInput(),
      files: [
        {
          path: 'src/source/entry.ts',
          imports: [
            {
              raw: '../target/entry.ts',
              kind: 'module',
              resolvedPath: 'src/target/entry.ts',
            },
          ],
        },
        { path: 'src/target/entry.ts', imports: [] },
      ],
      modulePaths: [
        { path: 'src/source', isBarrel: false },
        { path: 'src/target', isBarrel: false },
      ],
      moduleConfig: { 'src/source': 'source', 'src/target': 'target' },
      depRules: { other: () => true },
    });

    expect(output).toHaveProperty('error.message');
    if (!('error' in output)) return;
    expect(output.error.message).toContain('SH-002');
  });
});

describe.skipIf(!nativeEnabled)('incremental ProjectHandle', () => {
  it('materializes callbacks across native method calls and applies an overlay', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sheriff-r4-napi-'));
    try {
      const sourceDirectory = path.join(root, 'src/source');
      const targetDirectory = path.join(root, 'src/target');
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(targetDirectory, { recursive: true });
      const entryFile = path.join(sourceDirectory, 'entry.ts');
      const targetFile = path.join(targetDirectory, 'entry.ts');
      const tsConfigPath = path.join(root, 'tsconfig.json');
      writeFileSync(tsConfigPath, '{}');
      writeFileSync(entryFile, "import '../target/entry';\n");
      writeFileSync(targetFile, 'export const target = true;\n');

      const handle = new ProjectHandle({
        schemaVersion: 1,
        entryFile,
        tsConfigPath,
        modulePaths: [
          { path: sourceDirectory, isBarrel: false },
          { path: targetDirectory, isBarrel: false },
        ],
        moduleConfig: {
          'src/source': 'source',
          'src/target': 'target',
        },
        autoTagging: true,
        depRules: {
          source: ({ to, toFilePath }) =>
            to === 'target' && toFilePath.endsWith('/src/target/entry.ts'),
          target: [],
        },
        denyRules: {},
        externalRules: {},
        enableBarrelLess: true,
      });
      const initial = JSON.parse(handle.getResult()) as EngineOutput;
      expect(initial.violations.dependency).toEqual([]);

      const overlaid = JSON.parse(
        handle.setOverlay(entryFile, 'export const local = true;\n'),
      ) as EngineOutput;
      expect(overlaid.violations.dependency).toEqual([]);
      expect(JSON.parse(handle.getReachedFiles()).files).toEqual([
        'src/source/entry.ts',
      ]);

      const restored = JSON.parse(handle.clearOverlay(entryFile)) as EngineOutput;
      expect(restored).toEqual(initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function baseInput(): EngineInput {
  return {
    schemaVersion: 1,
    rootDir: '/project',
    files: [],
    modulePaths: [],
    moduleConfig: {},
    autoTagging: true,
    depRules: {},
    denyRules: {},
    externalRules: {},
    encapsulationPattern: 'internal',
    enableBarrelLess: true,
    excludeRoot: false,
    barrelFileName: 'index.ts',
  };
}

function dependencyInput(): EngineInput {
  return {
    ...baseInput(),
    files: [
      {
        path: 'src/source/entry.ts',
        imports: [
          {
            raw: '../target/entry.ts',
            kind: 'module',
            resolvedPath: 'src/target/entry.ts',
          },
        ],
      },
      { path: 'src/target/entry.ts', imports: [] },
    ],
    modulePaths: [
      { path: 'src/source', isBarrel: false },
      { path: 'src/target', isBarrel: false },
    ],
    moduleConfig: { 'src/source': 'source', 'src/target': 'target' },
  };
}

function analyze(input: EngineInput): EngineOutput | EngineErrorOutput {
  return JSON.parse(analyzeProject(input)) as EngineOutput | EngineErrorOutput;
}

function createEngineInput(
  oracle: EngineOracle,
  config: UserSheriffConfig,
): EngineInput {
  return {
    schemaVersion: 1,
    rootDir: oracle.rootDir,
    files: oracle.files.map(({ path: filePath, imports }) => ({
      path: filePath,
      imports,
    })),
    modulePaths: oracle.modules
      .filter((module) => module.path !== '.')
      .map((module) => ({ path: module.path, isBarrel: module.isBarrel })),
    moduleConfig: (config.modules ?? {}) as EngineInput['moduleConfig'],
    autoTagging: config.autoTagging ?? true,
    depRules: config.depRules as EngineInput['depRules'],
    denyRules: (config.denyRules ?? {}) as EngineInput['denyRules'],
    externalRules: (config.externalRules ?? {}) as EngineInput['externalRules'],
    encapsulationPattern: config.encapsulationPattern ?? 'internal',
    enableBarrelLess: config.enableBarrelLess ?? false,
    excludeRoot: config.excludeRoot ?? false,
    barrelFileName: config.barrelFileName ?? 'index.ts',
  };
}

function reportScenarioPlan(): void {
  for (const fixture of oracleFixtures) {
    const status = nativeEnabled ? 'RUN' : `SKIPPED — ${nativeSkipReason}`;
    console.info(`[sheriff-engine conformance] ${status}: ${fixture.name}`);
  }
}
