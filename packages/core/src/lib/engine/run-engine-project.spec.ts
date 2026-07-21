import { describe, expect, it } from 'vitest';
import type { ProjectHandleInput } from '@lambda-solutions/sheriff-engine';
import { runEngineProject } from './run-engine-project';

describe('runEngineProject', () => {
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
