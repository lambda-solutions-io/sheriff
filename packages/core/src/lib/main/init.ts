import { FsPath } from '../file-info/fs-path';
import { Configuration } from '../config/configuration';
import { TsData } from '../file-info/ts-data';
import { ParsedResult, parseProject } from './parse-project';
import { initialized } from './internal/initialized';
import { callbacks } from './internal/callback';
import { resolveProjectConfig } from './resolve-project-config';

let config: Configuration | undefined;

export type ProjectInfo = {
  tsData: TsData;
  config: Configuration;
  /** The config file selected for this project's entry file. */
  configFilePath?: FsPath;
  /** Whether the root config declares additional per-directory configs. */
  usesMultipleConfigs: boolean;
} & ParsedResult;

/**
 * @property {boolean} [returnOnMissingConfig] - If config file is missing, would return undefined
 * @property {boolean} [traverse] - If import files should be traversed or stopped after entry file's
 * @property {string} [entryFileContent] - ESLint needed in order to process unsaved content
 */
export type InitOptions = {
  returnOnMissingConfig?: boolean;
  traverse?: boolean;
  entryFileContent?: string;
};

/**
 * Central initialisation which generates the central `FileInfo` element.
 * All tools (ESLint, CLI) need to call this one.
 *
 * It requires an entryFile `main.ts`. From there, it
 * locates the main `tsconfig.json` and defines its path as `rootPath`.
 *
 * The next step is to load `sheriff.config.ts`. It will be parsed and
 * merged with default values. If the `sheriff.config.ts` does not exist
 * the default values will be returned together with property
 * `isConfigFileMissing` set to true.
 *
 * The dependency rule checks require a config. They require the
 * information of `isConfigFileMissing`.
 *
 * Last step is to start with the analysis of the project by generating
 * the FileInfo. That it is a Tree structure, following the import commands
 * of the files where the root one is the entryFile.
 * For ESLint rules which focus on a single file, there is the option
 * to only include the imports of the entryFile but not traverse any
 * further.
 *
 * @param {FsPath} entryFile - The entry file path.
 * @param {InitOptions} options - option to traverse
 *
 * @return {ProjectInfo} An object containing the generated TypeScript data and the configuration.
 **/
export function init(entryFile: FsPath): ProjectInfo;

export function init<Options extends { returnOnMissingConfig: true }>(
  entryFile: FsPath,
  options: InitOptions & Options,
): ProjectInfo | undefined;

export function init(entryFile: FsPath, options: InitOptions): ProjectInfo;

export function init(
  entryFile: FsPath,
  options: InitOptions = {},
): ProjectInfo | undefined {
  const fullOptions = {
    ...{ traverse: true, returnOnMissingConfig: false },
    ...options,
  };
  const { tsData, ...resolvedConfig } = resolveProjectConfig(entryFile);
  config = resolvedConfig.config;

  initialized.status = true;
  for (const callback of callbacks) {
    callback(config);
  }

  if (config.isConfigFileMissing && options.returnOnMissingConfig) {
    return;
  }

  return {
    tsData,
    config: resolvedConfig.config,
    configFilePath: resolvedConfig.configFilePath,
    usesMultipleConfigs: resolvedConfig.usesMultipleConfigs,
    ...parseProject(
      entryFile,
      fullOptions.traverse,
      tsData,
      config,
      options.entryFileContent,
    ),
  };
}
