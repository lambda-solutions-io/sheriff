import { ModuleConfig } from '../../config/module-config';
import { FsPath } from '../../file-info/fs-path';
import {
  createModulePathPatternsTree,
  ModulePathPatternsTree,
} from './create-module-path-patterns-tree';
import getFs from '../../fs/getFs';
import { flattenModules } from './flatten-modules';
import { matchesFolderSegmentPattern } from './segment-pattern';

/**
 * The current criterion for finding modules is via
 * the SheriffConfig's property `modules`.
 *
 * We will traverse the filesystem and match directories
 * against the patterns.
 *
 * @param includeDirectoriesWithBarrel Whether a matched directory which
 * contains the barrel file is returned as well. With
 * `moduleIdentity: 'auto'` it is `false`: such directories are picked up by
 * `findModulePathsWithBarrel`, the sole source of barrel modules in that
 * mode. With `moduleIdentity: 'config'` it is `true`: the `modules`
 * configuration is the only source of module identity, so a barrel file must
 * not drop a configured directory from the result.
 */
export function findModulePathsWithoutBarrel(
  moduleConfig: ModuleConfig,
  rootDir: FsPath,
  barrelFileName: string,
  includeDirectoriesWithBarrel = false,
): Set<FsPath> {
  const paths = flattenModules(moduleConfig, '');
  const modulePathsPatternTree = createModulePathPatternsTree(paths);
  const modules = traverseAndMatch(
    modulePathsPatternTree,
    rootDir,
    barrelFileName,
    includeDirectoriesWithBarrel,
  );
  return new Set<FsPath>(modules);
}

/**
 * Recursively traverse the filesystem and match directories against patterns.
 */
function traverseAndMatch(
  groupedPatterns: ModulePathPatternsTree,
  basePath: FsPath,
  barrelFileName: string,
  includeDirectoriesWithBarrel: boolean,
): FsPath[] {
  const fs = getFs();
  const matchedDirectories: FsPath[] = [];
  const addModule = (directory: FsPath) =>
    addAsModule(
      matchedDirectories,
      directory,
      barrelFileName,
      includeDirectoriesWithBarrel,
    );

  // Check if the current directory should be matched
  if ('' in groupedPatterns) {
    addModule(basePath);
  }

  const subDirectories = fs.readDirectory(basePath, 'directory');
  for (const subDirectory of subDirectories) {
    const currentSegment = fs.relativeTo(basePath, subDirectory);

    const patterns = Object.keys(groupedPatterns);
    const matchingPattern = patterns.find((pattern) =>
      matchesFolderSegmentPattern(pattern, currentSegment),
    );

    if (matchingPattern) {
      if (Object.keys(groupedPatterns[matchingPattern]).length === 0) {
        addModule(subDirectory);
      } else {
        const newDirectories = traverseAndMatch(
          groupedPatterns[matchingPattern],
          subDirectory,
          barrelFileName,
          includeDirectoriesWithBarrel,
        );
        for (const newDirectory of newDirectories) {
          addModule(newDirectory);
        }
      }
    }
  }

  return matchedDirectories;
}

function addAsModule(
  modulePaths: FsPath[],
  directory: FsPath,
  barrelFileName: string,
  includeDirectoriesWithBarrel: boolean,
) {
  const fs = getFs();

  if (
    !includeDirectoriesWithBarrel &&
    fs.exists(fs.join(directory, barrelFileName))
  ) {
    return;
  }

  modulePaths.push(directory);
}
