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
import { lastPathSeparatorIndex } from '../util/path-separators';

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

/** Finds the deepest ancestor module using one set probe per path segment. */
export function findClosestModulePath(
  path: string,
  modulePaths: ReadonlySet<FsPath>,
  rootDir: FsPath,
): FsPath {
  let currentPath = path;

  while (currentPath) {
    if (modulePaths.has(currentPath as FsPath)) {
      return currentPath as FsPath;
    }

    if (currentPath === rootDir) {
      break;
    }

    // paths can mix separators (tsconfig-derived vs fs-derived on Windows);
    // cut at whichever separator comes last.
    const separatorIndex = lastPathSeparatorIndex(currentPath);
    if (separatorIndex <= 0) {
      break;
    }
    currentPath = currentPath.substring(0, separatorIndex);
  }

  // Files that are not under any module directory but share the rootDir
  // string prefix (e.g. `/repo/src2/x.ts` with rootDir `/repo/src`) were
  // assigned to the root module by the previous prefix-based matching;
  // keep that behavior instead of throwing.
  if (path.startsWith(rootDir) && modulePaths.has(rootDir)) {
    return rootDir;
  }

  return throwIfNull(undefined, `findClosestModule for ${path}`);
}
