import { FsPath } from '../file-info/fs-path';
import * as ts from 'typescript';
import { UserSheriffConfig } from './user-sheriff-config';
import getFs from '../fs/getFs';
import { Configuration } from './configuration';
import {
  AllowBarrelsInWithoutBarrelPolicyError,
  BarrelPolicyWithoutBarrelLessError,
  CollidingEncapsulationSettings,
  CollidingEntrySettings,
  InvalidConfigsDirectoryError,
  MissingModulesWithoutAutoTaggingError,
  ModuleIdentityConfigWithoutBarrelLessError,
  NoEntryPointsFoundError,
  RootConfigsDirectoryError,
  TaggingAndModulesError,
} from '../error/user-error';
import { defaultConfig } from './default-config';
import { anyTag } from '../checks/any-tag';
import { sameTag } from '../checks/same-tag';
import { noDependencies } from '../checks/no-dependencies';
import { defineConfig } from './define-config';
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

/**
 * Reads, transpiles and evaluates a Sheriff config file and returns the RAW
 * user config — exactly the options its author wrote down, without the
 * defaults merged in.
 *
 * {@link parseConfig} returns the merged {@link Configuration}, in which an
 * option that was never set is indistinguishable from one set to its default
 * value. `sheriff doctor` needs precisely that distinction to report options
 * which a sub-config silently inherits from the defaults instead of from the
 * root config.
 */
export const readUserConfig = (configFile: FsPath): UserSheriffConfig => {
  const tsCode = getFs().readFile(configFile);

  const { outputText } = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.NodeNext },
  });

  // `eval` resolves a bare `require` relative to THIS module, not to the
  // config file. A config importing values from Sheriff itself — `anyTag`,
  // `defineConfig`, ... — would therefore fail whenever the running core is
  // not resolvable from here (CLI invoked by absolute path, in-process
  // tests). Sheriff's own exports are already loaded, so serve them from
  // memory and delegate everything else. Read by the `eval`ed code below,
  // which the linter cannot see.
  // eslint-disable-next-line unused-imports/no-unused-vars
  const require = createConfigRequire();

  return eval(outputText) as UserSheriffConfig;
};

const sheriffPackageNames = [
  '@lambda-solutions/sheriff-core',
  '@softarc/sheriff-core',
];

/**
 * The values a config file may import from Sheriff. Imported from their own
 * modules instead of the package barrel, which would import this file back.
 */
const sheriffConfigExports = {
  anyTag,
  sameTag,
  noDependencies,
  defineConfig,
};

/**
 * `require` for an eval'd config file: Sheriff's own package resolves to the
 * running instance, any other module keeps the default behaviour.
 */
const createConfigRequire = (): NodeJS.Require => {
  const configRequire = ((moduleName: string) =>
    sheriffPackageNames.includes(moduleName)
      ? sheriffConfigExports
      : // the config file is CommonJS, so delegation must be `require`
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require(moduleName)) as NodeJS.Require;

  return Object.assign(configRequire, require);
};

const computeParsedConfig = (
  configFile: FsPath,
  fullOptions: Required<ParseConfigOptions>,
): Configuration => {
  const userSheriffConfig = readUserConfig(configFile);

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

  const barrelPolicy = userSheriffConfig.barrelPolicy ?? 'allow';
  if (barrelPolicy !== 'allow' && userSheriffConfig.enableBarrelLess !== true) {
    throw new BarrelPolicyWithoutBarrelLessError(barrelPolicy);
  }

  if (
    (userSheriffConfig.allowBarrelsIn ?? []).length > 0 &&
    barrelPolicy === 'allow'
  ) {
    throw new AllowBarrelsInWithoutBarrelPolicyError();
  }

  if (
    userSheriffConfig.moduleIdentity === 'config' &&
    userSheriffConfig.enableBarrelLess !== true
  ) {
    throw new ModuleIdentityConfigWithoutBarrelLessError();
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
  };
};

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

    // '' means the key resolves to the workspace root ('.', './', ...).
    // `resolveConfigForFile` could never select it, so the entry would be
    // silently dead configuration.
    if (relativeDirectory === '') {
      throw new RootConfigsDirectoryError(directory);
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
