import { FsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';

/**
 * Resolves which config file governs `filePath`, given the root config's
 * `configs` field.
 *
 * The most specific (deepest) matching entry wins. Files which no entry covers
 * are governed by the root config, for which `undefined` is returned.
 *
 * @param filePath the file to resolve the config for
 * @param rootDir the workspace root
 * @param configs the root config's `configs` field
 */
export const resolveConfigForFile = (
  filePath: FsPath,
  rootDir: FsPath,
  configs: Record<string, string>,
): string | undefined => {
  const fs = getFs();
  const relativeFileSegments = getRelativeSegments(filePath, rootDir);

  if (relativeFileSegments === undefined) {
    return undefined;
  }

  return Object.entries(configs)
    .map(([directory, configPath]) => ({
      configPath,
      directorySegments: fs.isAbsolute(directory)
        ? undefined
        : getRelativeSegments(fs.join(rootDir, directory), rootDir),
    }))
    .filter(
      (entry): entry is { configPath: string; directorySegments: string[] } =>
        entry.directorySegments !== undefined &&
        entry.directorySegments.length > 0 &&
        entry.directorySegments.every(
          (segment, index) => relativeFileSegments[index] === segment,
        ),
    )
    .sort(
      (left, right) =>
        right.directorySegments.length - left.directorySegments.length,
    )
    .at(0)?.configPath;
};

function getRelativeSegments(
  path: string,
  rootDir: FsPath,
): string[] | undefined {
  const relativePath = getFs().relativeTo(rootDir, path).replaceAll('\\', '/');

  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    getFs().isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return relativePath.split('/').filter((segment) => segment !== '');
}
