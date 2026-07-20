import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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
const { analyzeProject, EngineImpureCallbackError } =
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
          context.fromModulePath === 'src/source' &&
          context.fromFilePath === 'src/source/entry.ts',
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
      ...baseInput(),
      depRules: { root: () => calls++ % 2 === 0 },
    };

    expect(() => analyzeProject(input)).toThrow(EngineImpureCallbackError);
    expect(calls).toBe(0);
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

function baseInput(): EngineInput {
  return {
    schemaVersion: 1,
    rootDir: '.',
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
