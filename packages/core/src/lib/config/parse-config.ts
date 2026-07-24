import { isBuiltin } from 'module';
import { FsPath } from '../file-info/fs-path';
import * as ts from 'typescript';
import { UserSheriffConfig } from './user-sheriff-config';
import getFs from '../fs/getFs';
import { ConfigImport, Configuration } from './configuration';
import {
  CollidingEncapsulationSettings,
  CollidingEntrySettings,
  InvalidConfigsDirectoryError,
  MissingModulesWithoutAutoTaggingError,
  NoEntryPointsFoundError,
  TaggingAndModulesError,
} from '../error/user-error';
import { defaultConfig } from './default-config';
import { isEmptyRecord } from '../util/is-empty-record';
import { getOrCompute } from '../cache/project-cache';

type ParseConfigOptions = {
  validateConfigs?: boolean;
};

export const parseConfig = (
  configFile: FsPath,
  options: ParseConfigOptions = {},
): Configuration => {
  const fullOptions = { validateConfigs: true, ...options };

  // transpiling + evaluating the config is expensive and ESLint triggers
  // it once per linted file. Callers never mutate the returned
  // `Configuration`, so a shared instance per config file is safe.
  return getOrCompute(
    `parse-config\0${configFile}\0${fullOptions.validateConfigs}`,
    () => ({
      value: computeParsedConfig(configFile, fullOptions),
      dependencies: [configFile],
    }),
  );
};

const computeParsedConfig = (
  configFile: FsPath,
  fullOptions: Required<ParseConfigOptions>,
): Configuration => {
  const tsCode = getFs().readFile(configFile);

  const { outputText } = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.NodeNext },
  });

  const configImports: ConfigImport[] = [];
  const moduleShim = { exports: {} };
  const userSheriffConfig = evaluateConfig(
    createRecordingRequire(configImports),
    moduleShim.exports,
    moduleShim,
    outputText,
  ) as UserSheriffConfig;

  if (userSheriffConfig.tagging && userSheriffConfig.modules) {
    throw new TaggingAndModulesError();
  }
  if (userSheriffConfig.tagging) {
    userSheriffConfig.modules = userSheriffConfig.tagging;
  }

  if (userSheriffConfig.autoTagging === false && !userSheriffConfig.modules) {
    throw new MissingModulesWithoutAutoTaggingError();
  }

  if (
    userSheriffConfig.encapsulationPattern !== undefined &&
    userSheriffConfig.encapsulatedFolderNameForBarrelLess !== undefined
  ) {
    throw new CollidingEncapsulationSettings();
  }

  if (userSheriffConfig.encapsulatedFolderNameForBarrelLess) {
    userSheriffConfig.encapsulationPattern =
      userSheriffConfig.encapsulatedFolderNameForBarrelLess;
  }

  const {
    tagging: _1,
    encapsulatedFolderNameForBarrelLess: _2,
    ...rest
  } = userSheriffConfig;

  if (userSheriffConfig.entryFile && userSheriffConfig.entryPoints) {
    throw new CollidingEntrySettings();
  }

  if (
    userSheriffConfig.entryPoints &&
    isEmptyRecord(userSheriffConfig.entryPoints)
  ) {
    throw new NoEntryPointsFoundError();
  }

  if (fullOptions.validateConfigs) {
    validateConfigsKeys(
      userSheriffConfig.configs ?? {},
      getFs().getParent(configFile),
    );
  }

  const mergedConfig = { ...defaultConfig, ...rest };

  const ignoreFileExtensions = getIgnoreFileExtensions(
    mergedConfig.ignoreFileExtensions,
  );

  return {
    ...mergedConfig,
    ignoreFileExtensions,
    configImports,
  };
};

/**
 * Evaluates the transpiled CommonJS output of `sheriff.config.ts`.
 *
 * The direct `eval` inside this function makes the injected `require`,
 * `exports` and `module` parameters visible to the evaluated code, while
 * preserving the completion value of the last statement
 * (`exports.config = {...}`) — exactly the value the previous bare
 * `eval(outputText)` returned.
 */
const evaluateConfig = new Function(
  'require',
  'exports',
  'module',
  'return eval(arguments[3]);',
) as (
  require: (specifier: string) => unknown,
  exports: object,
  module: { exports: object },
  outputText: string,
) => unknown;

/**
 * Creates a `require` replacement which delegates to the real `require` but
 * records the provenance of every specifier: the `require.resolve` result and
 * its canonical path with symlinks resolved. The canonical path reveals which
 * workspace build is actually loaded when `node_modules` entries are
 * symlinked (pnpm, yalc, workspaces).
 *
 * The replacement exposes the full `require` surface (`resolve`, `cache`,
 * `extensions`, `main`), so config code calling e.g. `require.resolve(...)`
 * keeps working; such calls are recorded as well. Node builtins (`path`,
 * `node:fs`, ...) are not recorded — they carry no build provenance. Every
 * specifier is recorded once; resolution failures are recorded with their
 * error message and the original error is rethrown unchanged.
 *
 * Note: specifiers resolve relative to the Sheriff core package — not
 * relative to the config file — because the config is evaluated in-process.
 */
function createRecordingRequire(configImports: ConfigImport[]): NodeJS.Require {
  const recordedSpecifiers = new Set<string>();

  const shouldRecord = (specifier: string): boolean => {
    if (isBuiltin(specifier) || recordedSpecifiers.has(specifier)) {
      return false;
    }
    recordedSpecifiers.add(specifier);
    return true;
  };

  const recordingResolve: NodeJS.RequireResolve = Object.assign(
    (specifier: string, options?: { paths?: string[] | undefined }) => {
      try {
        const resolvedPath = require.resolve(specifier, options);
        if (shouldRecord(specifier)) {
          configImports.push({
            specifier,
            resolvedPath,
            realPath: getFs().realpath(resolvedPath),
          });
        }
        return resolvedPath;
      } catch (error) {
        if (shouldRecord(specifier)) {
          configImports.push({
            specifier,
            resolvedPath: '',
            realPath: '',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    },
    { paths: require.resolve.paths },
  );

  return Object.assign(
    (specifier: string) => {
      recordingResolve(specifier);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate runtime delegation to the ambient CommonJS require, not a static import
      return require(specifier);
    },
    {
      resolve: recordingResolve,
      cache: require.cache,
      extensions: require.extensions,
      main: require.main,
    },
  );
}

function validateConfigsKeys(
  configs: Record<string, string>,
  rootDir: FsPath,
): void {
  const fs = getFs();

  for (const directory of Object.keys(configs)) {
    const relativeDirectory = fs
      .relativeTo(rootDir, fs.join(rootDir, directory))
      .replaceAll('\\', '/');

    if (
      fs.isAbsolute(directory) ||
      relativeDirectory === '..' ||
      relativeDirectory.startsWith('../') ||
      fs.isAbsolute(relativeDirectory)
    ) {
      throw new InvalidConfigsDirectoryError(directory);
    }
  }
}

function getIgnoreFileExtensions(
  ignoreFileExtensions: string[] | ((defaults: string[]) => string[]),
): string[] {
  const extensions =
    typeof ignoreFileExtensions === 'function'
      ? ignoreFileExtensions(defaultConfig.ignoreFileExtensions)
      : ignoreFileExtensions;
  return Array.from(new Set(extensions.map((ext) => ext.toLowerCase())));
}
