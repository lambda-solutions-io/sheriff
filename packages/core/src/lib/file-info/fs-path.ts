import getFs from '../fs/getFs';

/**
 * Domain Type representing an absolute and existing file
 */
export type FsPath = string & { type: 'FsPath' };

/**
 * Main Check function which is used by `isFsPath` and `toFsPath`.
 *
 * Always probes the filesystem. A positive result must not be cached
 * across calls: in long-lived processes (daemon, LSP, `verify --watch`)
 * a deleted file would otherwise keep validating as an existing FsPath
 * and re-enter the graph, surfacing later as a raw ENOENT (#50). The
 * daemon's watcher relies on `toFsPath` throwing for deleted files.
 */
const checkPath = (path: string): 'valid' | 'not absolute' | 'not existing' => {
  const fs = getFs();
  if (!fs.isAbsolute(path)) {
    return 'not absolute';
  }
  if (!fs.exists(path)) {
    return 'not existing';
  }

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

/**
 * Constructs an FsPath from an absolute path returned by a Dirent scan.
 * The caller must obtain the path from `readdirSync({ withFileTypes: true })`,
 * which establishes the entry's existence without another filesystem probe.
 * The trust is limited to this one call; later checks probe again.
 */
export const toFsPathFromDirent = (path: string): FsPath => {
  return path as FsPath;
};
