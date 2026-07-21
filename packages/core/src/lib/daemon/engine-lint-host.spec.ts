import type {
  EngineOutput,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectCache } from '../cache/project-cache';
import { parseConfig } from '../config/parse-config';
import { lintDocument } from '../eslint/lint-document';
import { toFsPath } from '../file-info/fs-path';
import { createEngineLintHost } from './engine-lint-host';

const nativeDirectory = path.resolve(
  __dirname,
  '../../../../sheriff-engine/native',
);
const nativeAvailable =
  fs.existsSync(nativeDirectory) &&
  fs.readdirSync(nativeDirectory).some((file) => file.endsWith('.node'));

describe('engine lint host', () => {
  let rootDir: string;
  let entryFile: string;
  const originalEngineDebug = process.env['SHERIFF_ENGINE_DEBUG'];

  beforeEach(() => {
    rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-engine-lint-host-'),
    );
    entryFile = writeFixtureProject(rootDir);
  });

  afterEach(() => {
    if (originalEngineDebug === undefined) {
      delete process.env['SHERIFF_ENGINE_DEBUG'];
    } else {
      process.env['SHERIFF_ENGINE_DEBUG'] = originalEngineDebug;
    }
    clearProjectCache();
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('maps every daemon lint field with TypeScript ordering', () => {
    const output = fixtureEngineOutput();
    const handle = createFakeHandle(output, [
      'src/source/index.ts',
      'src/target/internal.ts',
    ]);
    const host = createHost(() => handle);

    expect(host.lintFileViaEngine(entryFile)).toEqual(lintDocument(entryFile));
    expect(handle.getResult).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!nativeAvailable)(
    'matches the TypeScript DTO with a real ProjectHandle without fallback',
    () => {
      process.env['SHERIFF_ENGINE_DEBUG'] = '1';
      const debug = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const host = createEngineLintHost(rootDir, {
        getConfig: () =>
          parseConfig(toFsPath(path.join(rootDir, 'sheriff.config.ts'))),
      });

      expect(host.lintFileViaEngine(entryFile)).toEqual(
        lintDocument(entryFile),
      );
      expect(debug).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!nativeAvailable)(
    'reports an overlay-only violation and restores the disk graph',
    () => {
      const host = createEngineLintHost(rootDir, {
        getConfig: () =>
          parseConfig(toFsPath(path.join(rootDir, 'sheriff.config.ts'))),
      });
      const diskContent = fs.readFileSync(entryFile, 'utf8');

      expect(
        host.lintFileViaEngine(
          entryFile,
          `${diskContent}\nimport './overlay-only';\n`,
        )?.unresolvableImports,
      ).toContain('./overlay-only');
      expect(host.lintFileViaEngine(entryFile)?.unresolvableImports).toEqual([
        './missing',
      ]);
    },
  );

  it('builds and caches one handle for each configured entry', () => {
    const secondEntry = path.join(rootDir, 'src', 'second', 'index.ts');
    fs.mkdirSync(path.dirname(secondEntry), { recursive: true });
    fs.writeFileSync(secondEntry, 'export const second = true;\n');
    const config = parseConfig(
      toFsPath(path.join(rootDir, 'sheriff.config.ts')),
    );
    config.entryPoints = {
      app: 'src/source/index.ts',
      second: 'src/second/index.ts',
    };
    const createHandle = vi.fn((input: ProjectHandleInput) => {
      const relativeEntry = path
        .relative(path.dirname(input.tsConfigPath), input.entryFile)
        .replaceAll('\\', '/');
      return createFakeHandle(
        {
          ...emptyEngineOutput(),
          files: [{ path: relativeEntry, imports: [] }],
        },
        [relativeEntry],
      );
    });
    const host = createEngineLintHost(rootDir, {
      createHandle,
      getConfig: () => config,
    });

    expect(host.lintFileViaEngine(secondEntry)).toBeDefined();
    expect(host.lintFileViaEngine(entryFile)).toBeDefined();
    expect(createHandle).toHaveBeenCalledTimes(2);
    expect(createHandle.mock.calls.map(([input]) => input.entryFile)).toEqual([
      fs.realpathSync(entryFile),
      fs.realpathSync(secondEntry),
    ]);
  });

  it('uses an unsaved overlay and always clears it afterward', () => {
    const diskOutput = emptyEngineOutput();
    const overlayOutput: EngineOutput = {
      ...emptyEngineOutput(),
      files: [
        {
          path: 'src/source/index.ts',
          imports: [
            {
              raw: '../target/internal',
              kind: 'module',
              resolvedPath: 'src/target/internal.ts',
            },
          ],
        },
      ],
      violations: {
        dependency: [
          {
            file: 'src/source/index.ts',
            rawImport: '../target/internal',
            fromModulePath: 'src/source',
            toModulePath: 'src/target',
            toFilePath: 'src/target/internal.ts',
            fromTag: 'source:b',
            toTags: ['target:a', 'target:b'],
          },
        ],
        encapsulation: [],
        external: [],
      },
    };
    let currentOutput = diskOutput;
    const handle = createFakeHandle(diskOutput, [
      'src/source/index.ts',
      'src/target/internal.ts',
    ]);
    handle.getResult.mockImplementation(() => JSON.stringify(currentOutput));
    handle.setOverlay.mockImplementation(() => {
      currentOutput = overlayOutput;
      return JSON.stringify(currentOutput);
    });
    handle.clearOverlay.mockImplementation(() => {
      currentOutput = diskOutput;
      return JSON.stringify(currentOutput);
    });
    const host = createHost(() => handle);

    expect(
      host.lintFileViaEngine(entryFile, "import '../target/internal';\n")
        ?.dependencyRuleViolations,
    ).toHaveLength(1);
    expect(handle.clearOverlay).toHaveBeenCalledWith(
      fs.realpathSync(entryFile),
    );
    expect(host.lintFileViaEngine(entryFile)?.dependencyRuleViolations).toEqual(
      [],
    );
  });

  it('returns undefined for a file outside every reached set', () => {
    const uncovered = path.join(rootDir, 'src', 'uncovered.ts');
    fs.writeFileSync(uncovered, 'export const uncovered = true;\n');
    const handle = createFakeHandle(emptyEngineOutput(), [
      'src/source/index.ts',
    ]);

    expect(
      createHost(() => handle).lintFileViaEngine(uncovered),
    ).toBeUndefined();
  });

  it('drops all handles on invalidation and rebuilds lazily', () => {
    const changedOutput = fixtureEngineOutput();
    const createHandle = vi
      .fn<(input: ProjectHandleInput) => ReturnType<typeof createFakeHandle>>()
      .mockReturnValueOnce(
        createFakeHandle(emptyEngineOutput(), ['src/source/index.ts']),
      )
      .mockReturnValueOnce(
        createFakeHandle(changedOutput, [
          'src/source/index.ts',
          'src/target/internal.ts',
        ]),
      );
    const host = createHost(createHandle);

    expect(host.lintFileViaEngine(entryFile)?.dependencyRuleViolations).toEqual(
      [],
    );
    expect(createHandle).toHaveBeenCalledTimes(1);

    host.invalidate();

    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(
      host.lintFileViaEngine(entryFile)?.dependencyRuleViolations,
    ).toHaveLength(1);
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('disables the host for its lifetime when any handle build fails', () => {
    process.env['SHERIFF_ENGINE_DEBUG'] = '1';
    const debug = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    fs.appendFileSync(
      path.join(rootDir, 'sheriff.config.ts'),
      `
const inherited = { inherited: 'tag' };
Object.setPrototypeOf(config.modules, inherited);
`,
    );
    clearProjectCache();
    const createHandle = vi.fn(() =>
      createFakeHandle(emptyEngineOutput(), ['src/source/index.ts']),
    );
    const host = createHost(createHandle);

    expect(host.lintFileViaEngine(entryFile)).toBeUndefined();
    expect(host.lintFileViaEngine(entryFile)).toBeUndefined();
    host.invalidate();
    expect(host.lintFileViaEngine(entryFile)).toBeUndefined();

    expect(createHandle).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledOnce();
  });

  it('discards a handle whose overlay cannot be cleared', () => {
    const poisoned = createFakeHandle(emptyEngineOutput(), [
      'src/source/index.ts',
    ]);
    poisoned.clearOverlay.mockImplementation(() =>
      JSON.stringify({
        schemaVersion: 1,
        error: { code: 'SHERIFF_ENGINE_ERROR', message: 'clear failed' },
      }),
    );
    const healthy = createFakeHandle(emptyEngineOutput(), [
      'src/source/index.ts',
    ]);
    const createHandle = vi
      .fn<(input: ProjectHandleInput) => ReturnType<typeof createFakeHandle>>()
      .mockReturnValueOnce(poisoned)
      .mockReturnValueOnce(healthy);
    const host = createHost(createHandle);

    expect(
      host.lintFileViaEngine(entryFile, 'export const x = 1;'),
    ).toBeUndefined();
    expect(host.lintFileViaEngine(entryFile)).toBeDefined();
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('falls back for one failed request without disabling a healthy handle', () => {
    const handle = createFakeHandle(emptyEngineOutput(), [
      'src/source/index.ts',
    ]);
    handle.setOverlay.mockReturnValueOnce(
      JSON.stringify({
        schemaVersion: 1,
        error: { code: 'SHERIFF_ENGINE_ERROR', message: 'request failed' },
      }),
    );
    const createHandle = vi.fn(() => handle);
    const host = createHost(createHandle);

    expect(
      host.lintFileViaEngine(entryFile, 'export const x = 1;'),
    ).toBeUndefined();
    expect(host.lintFileViaEngine(entryFile)).toBeDefined();
    expect(createHandle).toHaveBeenCalledOnce();
    expect(handle.clearOverlay).toHaveBeenCalledOnce();
  });

  function createHost(
    createHandle: (
      input: ProjectHandleInput,
    ) => ReturnType<typeof createFakeHandle>,
  ) {
    return createEngineLintHost(rootDir, {
      createHandle,
      getConfig: () =>
        parseConfig(toFsPath(path.join(rootDir, 'sheriff.config.ts'))),
    });
  }
});

function createFakeHandle(output: EngineOutput, reachedFiles: string[]) {
  const currentOutput = output;
  return {
    getResult: vi.fn(() => JSON.stringify(currentOutput)),
    getReachedFiles: vi.fn(() =>
      JSON.stringify({ schemaVersion: 1, files: reachedFiles }),
    ),
    setOverlay: vi.fn(() => JSON.stringify(currentOutput)),
    clearOverlay: vi.fn(() => JSON.stringify(currentOutput)),
  };
}

function emptyEngineOutput(): EngineOutput {
  return {
    schemaVersion: 1,
    files: [{ path: 'src/source/index.ts', imports: [] }],
    modules: [],
    violations: { dependency: [], encapsulation: [], external: [] },
  };
}

function fixtureEngineOutput(): EngineOutput {
  return {
    schemaVersion: 1,
    files: [
      {
        path: 'src/source/index.ts',
        imports: [
          { raw: 'blocked-lib', kind: 'external' },
          {
            raw: '../target/internal',
            kind: 'module',
            resolvedPath: 'src/target/internal.ts',
          },
          { raw: './missing', kind: 'unresolvable' },
        ],
      },
      { path: 'src/target/internal.ts', imports: [] },
    ],
    modules: [],
    violations: {
      dependency: [
        {
          file: 'src/source/index.ts',
          rawImport: '../target/internal',
          fromModulePath: 'src/source',
          toModulePath: 'src/target',
          toFilePath: 'src/target/internal.ts',
          fromTag: 'source:b',
          toTags: ['target:a', 'target:b'],
        },
      ],
      encapsulation: [
        {
          file: 'src/source/index.ts',
          rawImport: '../target/internal',
          toFilePath: 'src/target/internal.ts',
        },
      ],
      external: [
        {
          file: 'src/source/index.ts',
          externalLibrary: 'blocked-lib',
          fromTag: 'source:b',
        },
      ],
    },
  };
}

function writeFixtureProject(rootDir: string): string {
  const write = (relativePath: string, contents: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  };

  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }),
  );
  write(
    'package.json',
    JSON.stringify({ dependencies: { 'blocked-lib': '1.0.0' } }),
  );
  write(
    'sheriff.config.ts',
    `export const config = {
  entryPoints: { app: 'src/source/index.ts' },
  modules: {
    'src/source': ['source:b', 'source:a'],
    'src/target': ['target:b', 'target:a'],
  },
  depRules: {
    'source:*': [],
    'target:*': '*',
  },
  externalRules: {
    'source:*': [],
  },
};`,
  );
  write(
    'src/source/index.ts',
    `import 'blocked-lib';
import { internal } from '../target/internal';
import './missing';
export const source = internal;
`,
  );
  write('src/target/index.ts', 'export const target = true;\n');
  write('src/target/internal.ts', 'export const internal = true;\n');

  return path.join(rootDir, 'src', 'source', 'index.ts');
}
