import { FsPath } from '../file-info/fs-path';
import { FileInfo } from '../modules/file.info';
import { generateUnassignedFileInfo } from '../file-info/generate-unassigned-file-info';
import { getProjectDirsFromFileInfo } from '../modules/get-project-dirs-from-file-info';
import { createModules } from '../modules/create-modules';
import { fillFileInfoMap } from '../modules/fill-file-info-map';
import throwIfNull from '../util/throw-if-null';
import { TsData } from '../file-info/ts-data';
import { Module } from '../modules/module';
import { Configuration } from '../config/configuration';
import {
  findModulePaths,
  ModulePathMap,
} from '../modules/find-module-paths';
import {
  DEFAULT_STRUCTURE_CACHE_TTL_MS,
  getOrCompute,
} from '../cache/project-cache';

export type ParsedResult = {
  fileInfo: FileInfo;
  modules: Module[];
  rootDir: FsPath;
  getFileInfo: (path: FsPath) => FileInfo;
};

export const parseProject = (
  entryFile: FsPath,
  traverse: boolean,
  tsData: TsData,
  config: Configuration,
  fileContent?: string,
  configFilePath?: FsPath,
): ParsedResult => {
  const unassignedFileInfo = generateUnassignedFileInfo(
    entryFile,
    !traverse,
    tsData,
    config.ignoreFileExtensions,
    fileContent,
  );
  const rootDir = tsData.rootDir;

  const projectDirs = getProjectDirsFromFileInfo(unassignedFileInfo, rootDir);

  const fileInfoMap: Map<FsPath, FileInfo> = new Map();
  const getFileInfo = (path: FsPath) =>
    throwIfNull(fileInfoMap.get(path), `cannot find FileInfo for ${path}`);

  const modulePaths = getModuleSkeleton(
    projectDirs,
    rootDir,
    config,
    configFilePath,
  );

  // The cached skeleton contains only immutable module descriptions. Module
  // and FileInfo instances carry per-entry mutable state, so createModules
  // must rebuild them for every init() call to prevent cross-file leakage.
  const modules = createModules(modulePaths, fileInfoMap, getFileInfo, {
    entryFileInfo: unassignedFileInfo,
    rootDir,
    barrelFile: config.barrelFileName,
  });
  fillFileInfoMap(fileInfoMap, modules);

  const fileInfo = getFileInfo(unassignedFileInfo.path);

  return {
    fileInfo,
    rootDir,
    getFileInfo,
    modules,
  };
};

function getModuleSkeleton(
  projectDirs: FsPath[],
  rootDir: FsPath,
  config: Configuration,
  configFilePath?: FsPath,
): ModulePathMap {
  const projectIdentity = [...projectDirs].sort().join(',');
  const configIdentity = configFilePath ?? '<default-config>';

  return getOrCompute(
    `module-skeleton\0${rootDir}\0${configIdentity}\0${projectIdentity}`,
    () => ({
      value: findModulePaths(projectDirs, rootDir, config),
      dependencies: configFilePath ? [configFilePath] : [],
    }),
    { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
  );
}
