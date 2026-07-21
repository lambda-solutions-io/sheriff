import { afterEach, describe, expect, it, vitest } from 'vitest';
import type { ProjectHandleInput } from '@lambda-solutions/sheriff-engine';
import { loadEnginePackage, runEngineProject } from './run-engine-project';

const originalEngineDebug = process.env['SHERIFF_ENGINE_DEBUG'];

describe('runEngineProject', () => {
  afterEach(() => {
    if (originalEngineDebug === undefined) {
      delete process.env['SHERIFF_ENGINE_DEBUG'];
    } else {
      process.env['SHERIFF_ENGINE_DEBUG'] = originalEngineDebug;
    }
    vitest.restoreAllMocks();
  });

  it.each([
    'SHERIFF_ENGINE_NATIVE_MISSING',
    'SHERIFF_ENGINE_NATIVE_LOAD_FAILED',
    'SHERIFF_ENGINE_UNSUPPORTED_CONFIG',
    'SHERIFF_ENGINE_IMPURE_CALLBACK',
  ])('falls back for %s', (code) => {
    const error = Object.assign(new Error('engine unavailable'), {
      code,
      ...(code === 'SHERIFF_ENGINE_IMPURE_CALLBACK' ? { fallback: true } : {}),
    });

    expect(
      runEngineProject(input, () => {
        throw error;
      }),
    ).toBeUndefined();
  });

  it('falls back for any other thrown engine error', () => {
    expect(
      runEngineProject(input, () => {
        throw new Error('unexpected failure');
      }),
    ).toBeUndefined();
  });

  it('falls back for a structured engine error result', () => {
    expect(
      runEngineProject(input, () => ({
        getResult: () =>
          JSON.stringify({
            schemaVersion: 1,
            error: { code: 'SHERIFF_ENGINE_ERROR', message: 'cannot resolve' },
          }),
      })),
    ).toBeUndefined();
  });

  it('uses the primary package resolution when it is present', () => {
    const enginePackage = { ProjectHandle: class {} };
    const loadModule = vitest.fn(() => enginePackage);

    expect(loadEnginePackage(loadModule)).toBe(enginePackage);
    expect(loadModule).toHaveBeenCalledOnce();
    expect(loadModule).toHaveBeenCalledWith('@lambda-solutions/sheriff-engine');
  });

  it('logs a requested-but-unavailable engine and returns undefined', () => {
    process.env['SHERIFF_ENGINE_DEBUG'] = '1';
    const debug = vitest.spyOn(console, 'error').mockImplementation(() => {});
    const missingPackage = Object.assign(
      new Error("Cannot find module '@lambda-solutions/sheriff-engine'"),
      { code: 'MODULE_NOT_FOUND' },
    );

    expect(
      runEngineProject(input, () => {
        loadEnginePackage(() => {
          throw missingPackage;
        }, '/private/tmp/sheriff-engine-does-not-exist');
        throw new Error('unreachable');
      }),
    ).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('SHERIFF_ENGINE_PACKAGE_MISSING'),
    );
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('source-worktree development fallback'),
    );
  });

  it('does not treat a transitive load failure as a missing engine package', () => {
    const transitiveFailure = Object.assign(
      new Error("Cannot find module 'native-transitive-dependency'"),
      { code: 'MODULE_NOT_FOUND' },
    );
    const loadModule = vitest.fn(() => {
      throw transitiveFailure;
    });

    expect(() => loadEnginePackage(loadModule)).toThrow(transitiveFailure);
    expect(loadModule).toHaveBeenCalledOnce();
    expect(loadModule).toHaveBeenCalledWith('@lambda-solutions/sheriff-engine');
  });
});

const input: ProjectHandleInput = {
  schemaVersion: 1,
  entryFile: '/project/src/main.ts',
  tsConfigPath: '/project/tsconfig.json',
  moduleConfig: {},
  modulePaths: [],
  autoTagging: true,
  depRules: {},
  denyRules: {},
  externalRules: {},
  enableBarrelLess: false,
};
