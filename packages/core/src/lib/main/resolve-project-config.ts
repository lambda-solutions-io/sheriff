import { Configuration } from '../config/configuration';
import { defaultConfig } from '../config/default-config';
import { findConfig } from '../config/find-config';
import { parseConfig } from '../config/parse-config';
import { resolveConfigEntryForFile } from '../config/resolve-config-for-file';
import { SheriffConfigNotFoundError } from '../error/user-error';
import { generateTsData } from '../file-info/generate-ts-data';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { TsData } from '../file-info/ts-data';
import getFs from '../fs/getFs';

export type ResolvedProjectConfig = {
  tsData: TsData;
  config: Configuration;
  configFilePath?: FsPath;
  usesMultipleConfigs: boolean;
  rootDir: FsPath;
};

/** Resolves TypeScript and Sheriff configuration without traversing imports. */
export function resolveProjectConfig(entryFile: FsPath): ResolvedProjectConfig {
  const fs = getFs();
  const tsConfigPath = toFsPath(
    fs.findNearestParentFile(entryFile, 'tsconfig.json'),
  );
  const tsData = generateTsData(tsConfigPath);
  const resolvedConfig = resolveConfigForEntry(entryFile, tsData.rootDir);

  return { tsData, rootDir: tsData.rootDir, ...resolvedConfig };
}

type ResolvedConfig = {
  config: Configuration;
  configFilePath?: FsPath;
  usesMultipleConfigs: boolean;
};

function resolveConfigForEntry(
  entryFile: FsPath,
  rootPath: FsPath,
): ResolvedConfig {
  const configFile = findConfig(rootPath);
  if (configFile) {
    const rootConfig = parseConfig(configFile);
    const selectedConfig = resolveConfigEntryForFile(
      entryFile,
      rootPath,
      rootConfig.configs,
    );
    const selectedConfigFile = selectedConfig
      ? resolveSelectedConfigFile(rootPath, selectedConfig)
      : configFile;

    return {
      config:
        selectedConfigFile === configFile
          ? rootConfig
          : parseConfig(selectedConfigFile, { validateConfigs: false }),
      configFilePath: selectedConfigFile,
      usesMultipleConfigs: Object.keys(rootConfig.configs).length > 0,
    };
  }

  return {
    config: { ...defaultConfig, isConfigFileMissing: true },
    usesMultipleConfigs: false,
  };
}

function resolveSelectedConfigFile(
  rootPath: FsPath,
  selectedConfig: { directory: string; configPath: string },
): FsPath {
  const fs = getFs();
  const selectedConfigFile = fs.isAbsolute(selectedConfig.configPath)
    ? selectedConfig.configPath
    : fs.join(rootPath, selectedConfig.configPath);

  if (!fs.exists(selectedConfigFile)) {
    throw new SheriffConfigNotFoundError(
      selectedConfig.directory,
      selectedConfig.configPath,
    );
  }

  return toFsPath(selectedConfigFile);
}
