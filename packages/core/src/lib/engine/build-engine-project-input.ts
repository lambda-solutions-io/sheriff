import type {
  EngineInput,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';
import getFs from '../fs/getFs';
import type { ProjectInfo } from '../main/init';

/**
 * Builds the native engine input for an already initialized Sheriff project.
 */
export function buildEngineProjectInput(
  projectInfo: ProjectInfo,
  entryFile: string,
): ProjectHandleInput {
  const fs = getFs();
  const { config } = projectInfo;
  const tsConfigPath = projectInfo.tsData.sourceConfigPaths[0];

  if (!tsConfigPath) {
    throw new Error('Cannot run the Sheriff engine without a tsconfig path.');
  }

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
    ...(projectInfo.configFilePath
      ? { sheriffConfigPaths: [projectInfo.configFilePath] }
      : {}),
  };
}

function relativeEnginePath(rootDir: string, path: string): string {
  return (getFs().relativeTo(rootDir, path) || '.').replaceAll('\\', '/');
}
