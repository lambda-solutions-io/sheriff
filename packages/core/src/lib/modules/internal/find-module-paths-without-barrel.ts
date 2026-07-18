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
 */
export function findModulePathsWithoutBarrel(
  moduleConfig: ModuleConfig,
  rootDir: FsPath,
  barrelFileName: string
): Set<FsPath> {
  const paths = flattenModules(moduleConfig, '');
  const modulePathsPatternTree = createModulePathPatternsTree(paths);
  const modules = traverseAndMatch(modulePathsPatternTree, rootDir, barrelFileName);
  return new Set<FsPath>(modules);
}

/**
 * Recursively traverse the filesystem and match directories against patterns.
 */
function traverseAndMatch(
  groupedPatterns: ModulePathPatternsTree,
  basePath: FsPath,
  barrelFileName: string
): FsPath[] {
  const fs = getFs();
  const matchedDirectories: FsPath[] = [];

  // Check if the current directory should be matched
  if ('' in groupedPatterns) {
    addAsModuleIfWithoutBarrel(matchedDirectories, basePath, barrelFileName);
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
        addAsModuleIfWithoutBarrel(matchedDirectories, subDirectory, barrelFileName);
      } else {
        const newDirectories = traverseAndMatch(groupedPatterns[matchingPattern], subDirectory, barrelFileName);
        for (const newDirectory of newDirectories) {
          addAsModuleIfWithoutBarrel(matchedDirectories, newDirectory, barrelFileName);
        }
      }
    }
  }

  return matchedDirectories;
}

function addAsModuleIfWithoutBarrel(
  modulePaths: FsPath[],
  directory: FsPath,
  barrelFileName: string,
) {
  const fs = getFs();

  if (fs.exists(fs.join(directory, barrelFileName))) {
    return;
  }

  modulePaths.push(directory);
}
