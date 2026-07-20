import { Module } from './module';
import { UnassignedFileInfo } from '../file-info/unassigned-file-info';
import traverseUnassignedFileInfo from '../file-info/traverse-unassigned-file-info';
import throwIfNull from '../util/throw-if-null';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { FileInfo } from './file.info';
import { ModulePathInfo, ModulePathMap } from './find-module-paths';
import {
  entries,
  fromEntries,
  keys,
  values,
} from '../util/typed-object-functions';

interface CreateModulesContext {
  entryFileInfo: UnassignedFileInfo;
  rootDir: FsPath;
  barrelFile: string;
}

export function createModules(
  modulePathMap: ModulePathMap,
  fileInfoMap: Map<FsPath, FileInfo>,
  getFileInfo: (path: FsPath) => FileInfo,
  { entryFileInfo, rootDir, barrelFile }: CreateModulesContext,
): Module[] {
  const moduleMap = fromEntries(
    entries(modulePathMap).map(([path, rawModulePathInfo]) => {
      const modulePathInfo = normalizeModulePathInfo(rawModulePathInfo);
      const module = new Module(
        toFsPath(path),
        fileInfoMap,
        getFileInfo,
        false,
        modulePathInfo.hasBarrel,
        barrelFile,
      );
      module.exportedFilePatterns = modulePathInfo.exports;
      return [path, module];
    }),
  );
  // add root module
  moduleMap[rootDir] = new Module(
    rootDir,
    fileInfoMap,
    getFileInfo,
    true,
    false,
    barrelFile,
  );

  const modulePaths = new Set(keys(moduleMap));

  for (const { fileInfo } of traverseUnassignedFileInfo(entryFileInfo)) {
    const modulePath = findClosestModulePath(
      fileInfo.path,
      modulePaths,
      rootDir,
    );
    moduleMap[modulePath].addFileInfo(fileInfo);
  }

  return values(moduleMap);
}

function normalizeModulePathInfo(
  modulePathInfo: boolean | ModulePathInfo,
): ModulePathInfo {
  return typeof modulePathInfo === 'boolean'
    ? { hasBarrel: modulePathInfo }
    : modulePathInfo;
}

function findClosestModulePath(
  path: string,
  modulePaths: Set<FsPath>,
  rootDir: FsPath,
) {
  let currentPath = path;
  const pathSeparator = path.startsWith('/') ? '/' : '\\';
  const rootPrefix = rootDir.endsWith(pathSeparator)
    ? rootDir
    : `${rootDir}${pathSeparator}`;

  if (!path.startsWith(rootPrefix)) {
    return throwIfNull(undefined, `findClosestModule for ${path}`);
  }

  while (currentPath) {
    if (modulePaths.has(currentPath as FsPath)) {
      return currentPath as FsPath;
    }

    if (currentPath === rootDir) {
      break;
    }

    const separatorIndex = currentPath.lastIndexOf(pathSeparator);
    currentPath =
      separatorIndex < rootDir.length
        ? rootDir
        : currentPath.substring(0, separatorIndex);
  }

  return throwIfNull(undefined, `findClosestModule for ${path}`);
}
