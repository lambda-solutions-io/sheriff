import { createProject } from '../../test/project-creator';
import { generateTsData } from '../generate-ts-data';
import { FileTree } from '../../test/project-configurator';
import { toFsPath } from '../fs-path';
import { TsPaths } from '../ts-data';
import { tsConfig } from '../../test/fixtures/ts-config';
import { describe, it, expect, test } from 'vitest';
import getFs from '../../fs/getFs';

describe('generateTsData', () => {
  function setup(
    paths: Record<string, string[]> | undefined,
    baseUrl: string | undefined,
    fileTree: FileTree,
  ): TsPaths {
    createProject({
      'tsconfig.json': tsConfig({ paths: paths, baseUrl }),
      ...fileTree,
    });

    return generateTsData(toFsPath('/project/tsconfig.json')).paths;
  }

  it('should have empty paths by default', () => {
    const paths = setup(undefined, undefined, {});
    expect(paths).toEqual({});
  });

  it('should provide paths as they are with missing baseUrl', () => {
    const paths = setup({ '@app': ['src/app'] }, undefined, {
      src: { app: {} },
    });

    expect(paths).toEqual({ '@app': '/project/src/app' });
  });

  it('should combine baseUrl', () => {
    const paths = setup({ '@app': ['app'] }, 'src', { src: { app: {} } });
    expect(paths).toEqual({ '@app': '/project/src/app' });
  });

  it('should also work with paths and wildcards', () => {
    const paths = setup({ '@app/*': ['app'] }, 'src', { src: { app: {} } });
    expect(paths).toEqual({ '@app/*': '/project/src/app' });
  });

  describe('memoization', () => {
    it('should reuse tsData until a config of the extends chain changes', () => {
      createProject({
        'tsconfig.base.json': JSON.stringify({ compilerOptions: {} }),
        'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      });
      const tsConfigPath = toFsPath('/project/tsconfig.json');

      const first = generateTsData(tsConfigPath);
      expect(first.sourceConfigPaths).toEqual([
        '/project/tsconfig.json',
        '/project/tsconfig.base.json',
      ]);
      expect(generateTsData(tsConfigPath)).toBe(first);

      getFs().writeFile(
        '/project/tsconfig.base.json',
        JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      );

      expect(generateTsData(tsConfigPath)).not.toBe(first);
    });
  });

  describe('missing or double dir separators', () => {
    for (const baseUrl of ['src', './src', 'src/']) {
      for (const path of ['app', './app'])
        test(`path: ${path}, baseUrl: ${baseUrl}`, () => {
          const paths = setup({ '@app/*': [path] }, baseUrl, {
            src: { app: {} },
          });
          expect(paths).toEqual({ '@app/*': '/project/src/app' });
        });
    }
  });
});
