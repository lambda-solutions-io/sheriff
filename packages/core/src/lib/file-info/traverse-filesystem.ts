import { UnassignedFileInfo } from './unassigned-file-info';
import getFs from '../fs/getFs';
import * as ts from 'typescript';
import { TsData } from './ts-data';
import { FsPath } from './fs-path';
import { resolvePotentialTsPath } from './resolve-potential-ts-path';
import { fixPathSeparators } from './fix-path-separators';
import { isInsideRoot } from './is-inside-root';
import { isRelativeImport } from '../eslint/is-relative-import';
import {
  extractPackageName,
  getDependencyUniverse,
} from './dependency-universe';
import {
  DEFAULT_STRUCTURE_CACHE_TTL_MS,
  getOrCompute,
} from '../cache/project-cache';

export type ResolveFn = (
  moduleName: string,
) => ReturnType<typeof ts.resolveModuleName>;

/**
 * Outcome of resolving a single import specifier of a file. Contains only
 * serializable data (no tree nodes), so it can be cached across runs.
 */
type ImportResolution =
  | { kind: 'module'; raw: string; importPath: FsPath }
  | { kind: 'external'; raw: string }
  | { kind: 'unresolvable'; raw: string };

// https://stackoverflow.com/questions/71815527/typescript-compiler-apihow-to-get-absolute-path-to-source-file-of-import-module
/**
 * This function generates the FileInfo tree.
 * It starts with the entry TypeScript file and traverse all its imports.
 *
 * It does not follow an import when it is an external library, i.e. comes from
 * node_modules. The same is true, if a file is already traversed.
 *
 * To improve the testability, we use abstraction whenever access to the
 * filesystem happens. In case the abstraction does not emulate the original's
 * behaviour, "strange bugs" might occur. Look out for them.
 *
 * fixPathSeparators is necessary to replace the static '/' path separator
 * with the one from the OS.
 *
 * @param fsPath Filename to traverse from
 * @param fileInfoDict Dictionary of traversed files to catch circularity
 * @param tsData
 * @param ignoreFileExtensions Array of file extensions to ignore
 * @param runOnce traverse only once. needed for ESLint mode
 * @param fileContent if passed, is used instead the content of @fsPath.
 * necessary for unsaved files inESLint
 */
export function traverseFilesystem(
  fsPath: FsPath,
  fileInfoDict: Map<FsPath, UnassignedFileInfo>,
  tsData: TsData,
  ignoreFileExtensions: string[],
  runOnce = false,
  fileContent?: string,
): UnassignedFileInfo {
  const fileInfo: UnassignedFileInfo = new UnassignedFileInfo(fsPath, []);
  fileInfoDict.set(fsPath, fileInfo);

  for (const resolution of getImportResolutions(
    fsPath,
    tsData,
    ignoreFileExtensions,
    fileContent,
  )) {
    if (resolution.kind === 'external') {
      fileInfo.addExternalLibrary(resolution.raw);
    } else if (resolution.kind === 'unresolvable') {
      fileInfo.addUnresolvableImport(resolution.raw);
    } else {
      const { importPath, raw } = resolution;
      const existing = fileInfoDict.get(importPath);
      if (existing) {
        fileInfo.addImport(existing, raw);
      } else if (runOnce) {
        fileInfo.addImport(new UnassignedFileInfo(importPath), raw);
      } else {
        fileInfo.addImport(
          traverseFilesystem(
            importPath,
            fileInfoDict,
            tsData,
            ignoreFileExtensions,
          ),
          raw,
        );
      }
    }
  }

  return fileInfo;
}

/**
 * Resolving imports (`ts.preProcessFile` + `ts.resolveModuleName` per
 * import) is the most expensive part of the traversal, so results are
 * cached per file. Unsaved editor content bypasses the cache entirely to
 * never poison it. Resolutions can also change when *other* files appear
 * (e.g. shadowing), which the staleness window covers.
 */
function getImportResolutions(
  fsPath: FsPath,
  tsData: TsData,
  ignoreFileExtensions: string[],
  fileContent?: string,
): ImportResolution[] {
  if (fileContent !== undefined) {
    return resolveImports(fsPath, tsData, ignoreFileExtensions, fileContent);
  }

  // the tsconfig of the entry file governs the resolution, so it is part
  // of the key: the same file can resolve differently per project.
  return getOrCompute(
    `import-resolutions\0${tsData.sourceConfigPaths[0]}\0${fsPath}`,
    () => ({
      value: resolveImports(
        fsPath,
        tsData,
        ignoreFileExtensions,
        getFs().readFile(fsPath),
      ),
      dependencies: [fsPath, ...tsData.sourceConfigPaths],
    }),
    { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
  );
}

function resolveImports(
  fsPath: FsPath,
  tsData: TsData,
  ignoreFileExtensions: string[],
  fileContent: string,
): ImportResolution[] {
  const { paths, sys, rootDir, baseUrl, configObject } = tsData;
  const fs = getFs();
  const preProcessedFile = ts.preProcessFile(fileContent);

  const config = { ...configObject.options, baseUrl };

  const resolveFn: ResolveFn = (moduleName: string) =>
    ts.resolveModuleName(moduleName, fsPath, config, sys);

  const resolutions: ImportResolution[] = [];

  for (const importedFile of preProcessedFile.importedFiles) {
    const { fileName } = importedFile;
    // skip configured ignored extensions early
    const fileExtension = fileName.split('.').pop()?.toLowerCase();
    if (fileExtension && ignoreFileExtensions.includes(fileExtension)) {
      continue;
    }
    const resolvedImport = resolveFn(fileName);

    // alias/path resolving has priority
    const resolvedTsPath = resolvePotentialTsPath(fileName, paths, resolveFn);

    if (resolvedTsPath) {
      resolutions.push({
        kind: 'module',
        raw: fileName,
        importPath: resolvedTsPath,
      });
    }

    // check if external library or normal file
    else if (resolvedImport.resolvedModule) {
      const { resolvedFileName } = resolvedImport.resolvedModule;
      if (!resolvedImport.resolvedModule.isExternalLibraryImport) {
        const importPath = fixPathSeparators(resolvedFileName);
        if (!isInsideRoot(importPath, rootDir)) {
          throw new Error(`${importPath} is outside of root ${rootDir}`);
        }
        resolutions.push({ kind: 'module', raw: fileName, importPath });
      } else {
        resolutions.push({ kind: 'external', raw: fileName });
      }
    }

    // might be an undetected dependency in node_modules
    // or an incomplete import (= developer is still typing),
    // if we read from an unsaved file via ESLint.
    else {
      const isDeclaredExternal =
        !isRelativeImport(fileName) &&
        !fs.isAbsolute(fileName) &&
        getDependencyUniverse(fs.getParent(fsPath), rootDir).has(
          extractPackageName(fileName),
        );

      resolutions.push({
        kind: isDeclaredExternal ? 'external' : 'unresolvable',
        raw: fileName,
      });
    }
  }

  return resolutions;
}
