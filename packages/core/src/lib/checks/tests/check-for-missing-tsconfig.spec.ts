import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { tsConfig } from '../../test/fixtures/ts-config';
import { createProject } from '../../test/project-creator';
import { checkForMissingTsConfig } from '../check-for-missing-tsconfig';

describe('checkForMissingTsConfig', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  it('should return undefined when the tsconfig.json is found', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    expect(checkForMissingTsConfig('src/main.ts')).toBeUndefined();
  });

  it('should accept an absolute entry file path', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    expect(checkForMissingTsConfig('/project/src/main.ts')).toBeUndefined();
  });

  it('should report a missing entry file', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    expect(checkForMissingTsConfig('src/app.ts')).toBe(
      'entry file src/app.ts does not exist',
    );
  });

  it('should report a missing tsconfig.json', () => {
    createProject({
      src: {
        'main.ts': [],
      },
    });

    expect(checkForMissingTsConfig('src/main.ts')).toBe(
      'no tsconfig.json found above src/main.ts',
    );
  });
});
