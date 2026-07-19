import * as path from 'path';
import type { FsPath } from '../file-info/fs-path';

export abstract class Fs {
  abstract writeFile(filename: string, contents: string): void;
  abstract appendFile(filename: string, contents: string): void;
  abstract readFile(path: FsPath): string;
  abstract readDirectory(path: FsPath, filter?: 'none' | 'directory'): FsPath[];
  abstract removeDir(path: FsPath): void;
  abstract createDir(path: string): void;
  abstract exists(path: string): path is FsPath;

  abstract tmpdir(): string;

  join = (...paths: string[]) => path.join(...paths);

  abstract cwd(): string;

  abstract findFiles(path: FsPath, filename: string): FsPath[];

  abstract print(): void;

  /**
   * Used for finding the nearest `tsconfig.json`. It traverses through the
   * parent folder and includes the directory of the referenceFile.
   * @param referenceFile
   * @param filename
   */
  abstract findNearestParentFile(
    referenceFile: FsPath,
    filename: string,
  ): FsPath;

  relativeTo(from: string, to: string) {
    return path.relative(from, to);
  }

  getParent(fileOrDirectory: FsPath): FsPath {
    return path.dirname(fileOrDirectory) as FsPath;
  }

  pathSeparator = path.sep;

  /**
   * Reset the VirtualFs, has no effect on the real `DefaultFs`.
   */
  abstract reset(): void;

  abstract split(path: string): string[];

  abstract isAbsolute(path: string): boolean;

  abstract isFile(path: FsPath): boolean

  /**
   * Canonicalizes a path: resolves symlinks and, on case-insensitive
   * filesystems, returns the on-disk casing. Used to compare a requested
   * file path against the paths in the project graph by identity rather
   * than by raw byte-string equality. Must fall back to the input path
   * when the target cannot be canonicalized (e.g. it does not exist).
   */
  abstract realpath(path: string): string;

  /**
   * Modification marker for cache invalidation. `DefaultFs` returns the
   * file's mtime in milliseconds, `VirtualFs` a monotonic write counter.
   * The only guarantee is that a change to the file yields a new value.
   */
  abstract lastModified(path: FsPath): number;
}
