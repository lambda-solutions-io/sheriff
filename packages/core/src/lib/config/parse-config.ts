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

  const userSheriffConfig = eval(outputText) as UserSheriffConfig;

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
