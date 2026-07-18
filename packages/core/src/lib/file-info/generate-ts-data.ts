import getFs, { isFsVirtualised } from '../fs/getFs';
import * as ts from 'typescript';
import { TsData } from './ts-data';
import { getTsConfigContext } from './get-ts-config-context';
import { FsPath, toFsPath } from './fs-path';
import { getOrCompute } from '../cache/project-cache';

/**
 * Generates a parsed TypeScript configuration from a given
 * path. The `paths` property will have its values merged
 * with the `baseUrl`.
 *
 * Example:
 *
 * ```json
 * {
 *   baseUrl: './src',
 *   paths: {
 *     'app/*': './app'
 *   }
 * }
 * ```
 *
 * This will return a paths property of `{'app/*': './src/app'}`
 */
export const generateTsData = (tsConfigPath: FsPath): TsData =>
  // the full tsconfig `extends` chain is parsed per call and ESLint calls
  // this once per linted file. All read configs are dependencies.
  getOrCompute(`generate-ts-data\0${tsConfigPath}`, () => {
    const tsData = computeTsData(tsConfigPath);
    return { value: tsData, dependencies: tsData.sourceConfigPaths };
  });

const computeTsData = (tsConfigPath: FsPath): TsData => {
  const configContext = getTsConfigContext(tsConfigPath);

  const fs = getFs();
  const cwd = fs.getParent(tsConfigPath);
  const configRawContent = getFs().readFile(tsConfigPath);
  const configContent = ts.readConfigFile(tsConfigPath, () => configRawContent);

  const configObject = ts.parseJsonConfigFileContent(
    configContent,
    ts.sys,
    cwd,
  );

  const sys = getTsSys();

  return {  ...configContext, configObject, cwd, sys};
};

function getTsSys(): ts.System {
  if (isFsVirtualised()) {
    const fs = getFs();
    return {
      fileExists: (path: string) => fs.exists(path),
      readFile(path: string): string | undefined {
        return fs.readFile(toFsPath(path));
      },
    } as unknown as typeof ts.sys;
  } else {
    return ts.sys;
  }
}
