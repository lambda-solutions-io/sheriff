import getFs from '../fs/getFs';

/**
 * Domain Type representing an absolute and existing file
 */
export type FsPath = string & { type: 'FsPath' };

/**
 * Main Check function which is used by `isFsPath` and `toFsPath`.
 * Uses a cache for valid paths.
 */
const fsPathCache = new Set<string>();
const checkPath = (path: string): 'valid' | 'not absolute' | 'not existing' => {
  if (fsPathCache.has(path)) {
    return 'valid';
  }

  const fs = getFs();
  if (!fs.isAbsolute(path)) {
    return 'not absolute';
  }
  if (!fs.exists(path)) {
    return 'not existing';
  }

  fsPathCache.add(path);
  return 'valid';
};

/**
 * Type Guard which checks if @param path is a valid FsPath
 * @param path
 */
export const isFsPath = (path: string): path is FsPath => {
  return checkPath(path) === 'valid';
};

/**
 * Maps a path to an FsPath without touching the filesystem.
 *
 * Only for callers that already have proof the absolute path exists — e.g. a
 * `Dirent` from `readdirSync(..., { withFileTypes: true })`, where the
 * directory read itself established existence. Using it there avoids one
 * `exists()` syscall per directory entry.
 *
 * The path is added to the shared cache so a later `toFsPath` on the same
 * path is free too. Passing a non-existing path breaks the `FsPath` contract.
 */
export const toExistingFsPath = (path: string): FsPath => {
  fsPathCache.add(path);
  return path as FsPath;
};

/**
 * Maps a path to an FsPath. Throws an error if the path does not exist or is
 * relative.
 */
export const toFsPath = (path: string): FsPath => {
  switch (checkPath(path)) {
    case 'not absolute':
      throw new Error(`FsPath: ${path} is not absolute`);
    case 'not existing':
      throw new Error(`FsPath: ${path} does not exist`);
    default:
      return path as FsPath;
  }
};
