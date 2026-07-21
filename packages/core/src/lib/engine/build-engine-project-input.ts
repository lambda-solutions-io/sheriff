import type {
  EngineModulePath,
  EngineInput,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';
import getFs from '../fs/getFs';
import type { ProjectInfo } from '../main/init';
import type { ResolvedProjectConfig } from '../main/resolve-project-config';

/**
 * Builds the native engine input for an already initialized Sheriff project.
 */
export function buildEngineProjectInput(
  projectInfo: ProjectInfo,
  entryFile: string,
): ProjectHandleInput {
  const modulePaths = projectInfo.modules
    .map((moduleInfo) => ({
      moduleInfo,
      path: relativeEnginePath(projectInfo.rootDir, moduleInfo.path),
    }))
    .filter(({ path }) => path !== '.')
    .map(({ moduleInfo, path }) => ({
      path,
      isBarrel: moduleInfo.hasBarrel,
      ...(moduleInfo.exportedFilePatterns === undefined
        ? {}
        : { exports: moduleInfo.exportedFilePatterns }),
    }));

  return buildEngineProjectInputFromConfig(projectInfo, entryFile, modulePaths);
}

/** Builds an engine input from configuration only, before TS graph traversal. */
export function buildEngineProjectInputFromConfig(
  projectConfig: ResolvedProjectConfig,
  entryFile: string,
  modulePaths: EngineModulePath[],
): ProjectHandleInput {
  const fs = getFs();
  const { config } = projectConfig;
  const tsConfigPath = projectConfig.tsData.sourceConfigPaths[0];

  if (!tsConfigPath) {
    throw new Error('Cannot run the Sheriff engine without a tsconfig path.');
  }

  assertOwnKeyedEngineConfig(config.modules, 'config.modules', true);
  assertOwnKeyedEngineConfig(config.depRules, 'config.depRules', false);
  assertOwnKeyedEngineConfig(config.denyRules, 'config.denyRules', false);
  assertOwnKeyedEngineConfig(
    config.externalRules,
    'config.externalRules',
    false,
  );

  return {
    schemaVersion: 1,
    entryFile: fs.isAbsolute(entryFile)
      ? entryFile
      : fs.join(fs.cwd(), entryFile),
    tsConfigPath,
    ignoreFileExtensions: config.ignoreFileExtensions,
    moduleConfig: config.modules as EngineInput['moduleConfig'],
    modulePaths,
    autoTagging: config.autoTagging ?? true,
    depRules: config.depRules as EngineInput['depRules'],
    denyRules: (config.denyRules ?? {}) as EngineInput['denyRules'],
    externalRules: (config.externalRules ?? {}) as EngineInput['externalRules'],
    encapsulationPattern: config.encapsulationPattern ?? 'internal',
    enableBarrelLess: config.enableBarrelLess ?? false,
    excludeRoot: config.excludeRoot ?? false,
    barrelFileName: config.barrelFileName ?? 'index.ts',
    ...(projectConfig.configFilePath
      ? { sheriffConfigPaths: [projectConfig.configFilePath] }
      : {}),
  };
}

function relativeEnginePath(rootDir: string, path: string): string {
  return (getFs().relativeTo(rootDir, path) || '.').replaceAll('\\', '/');
}

function assertOwnKeyedEngineConfig(
  value: unknown,
  configPath: string,
  inspectObjectValues: boolean,
): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  const expectedPrototype = Array.isArray(value)
    ? Array.prototype
    : Object.prototype;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== expectedPrototype && prototype !== null) {
    throwUnsupportedConfigContainer(configPath);
  }

  const ownEnumerableKeys = new Set(Object.keys(value));
  for (const key in value) {
    if (!ownEnumerableKeys.has(key)) {
      throwUnsupportedConfigContainer(configPath);
    }
  }

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable) {
      continue;
    }
    if (!('value' in descriptor)) {
      throwUnsupportedConfigContainer(`${configPath}.${key}`);
    }
    if (
      Array.isArray(descriptor.value) ||
      (inspectObjectValues &&
        descriptor.value !== null &&
        typeof descriptor.value === 'object' &&
        !(descriptor.value instanceof RegExp))
    ) {
      assertOwnKeyedEngineConfig(
        descriptor.value,
        `${configPath}.${key}`,
        inspectObjectValues,
      );
    }
  }
}

function throwUnsupportedConfigContainer(configPath: string): never {
  throw Object.assign(
    new Error(
      `Sheriff Rust engine cannot faithfully serialize ${configPath}; ` +
        'the config container must use only plain own-keyed data properties.',
    ),
    { code: 'SHERIFF_ENGINE_UNSUPPORTED_CONFIG' },
  );
}
