import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { SheriffConfigNotFoundError } from '../error/user-error';

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
): string | undefined =>
  resolveConfigEntryForFile(filePath, rootDir, configs)?.configPath;

export const resolveConfigEntryForFile = (
  filePath: FsPath,
  rootDir: FsPath,
  configs: Record<string, string>,
):
  | {
      directory: string;
      configPath: string;
    }
  | undefined => {
  const fs = getFs();
  const relativeFileSegments = getRelativeSegments(filePath, rootDir);

  if (relativeFileSegments === undefined) {
    return undefined;
  }

  return Object.entries(configs)
    .map(([directory, configPath]) => {
      const directorySegments = fs.isAbsolute(directory)
        ? undefined
        : getRelativeSegments(fs.join(rootDir, directory), rootDir);

      return {
        directory,
        configPath,
        directorySegments,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        directory: string;
        configPath: string;
        directorySegments: string[];
      } =>
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
    .at(0);
};

/**
 * Turns a `configs` entry into the absolute path of the config file it points
 * to.
 *
 * An entry pointing at a non-existent file is a hard error: the directory
 * would otherwise silently keep running on the root config.
 *
 * @param rootDir the workspace root
 * @param directory the `configs` key, only used for the error message
 * @param configPath the `configs` value, absolute or relative to `rootDir`
 */
export const resolveConfigFilePath = (
  rootDir: FsPath,
  directory: string,
  configPath: string,
): FsPath => {
  const fs = getFs();
  const configFile = fs.isAbsolute(configPath)
    ? configPath
    : fs.join(rootDir, configPath);

  if (!fs.exists(configFile)) {
    throw new SheriffConfigNotFoundError(directory, configPath);
  }

  return toFsPath(configFile);
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
