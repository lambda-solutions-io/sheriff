import { UnassignedFileInfo } from '../file-info/unassigned-file-info';
import { FileInfo } from './file.info';
import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';

/**
 * Since modules are constructed incrementally with in-place
 * modification, e.g. `addFileInfo`, a class is the better
 * approach here.
 */
export class Module {
  readonly fileInfos: FileInfo[] = [];

  /**
   * Module-relative file patterns that are importable from outside this module.
   *
   * `undefined` keeps the historical behavior: barrel-less modules expose every
   * file except those matching the configured encapsulation pattern.
   */
  exportedFilePatterns?: string[];

  constructor(
    public readonly path: FsPath,
    private readonly fileInfoMap: Map<FsPath, FileInfo>,
    private readonly getFileInfo: (fsPath: FsPath) => FileInfo,
    public readonly isRoot: boolean,
    public readonly hasBarrel: boolean,
    private readonly barrelFile: string,
  ) {
  }

  addFileInfo(unassignedFileInfo: UnassignedFileInfo) {
    const fileInfo = new FileInfo(unassignedFileInfo, this, this.getFileInfo);
    this.fileInfoMap.set(fileInfo.path, fileInfo);
    this.fileInfos.push(fileInfo);
  }

  get barrelPath(): FsPath {
    return toFsPath(getFs().join(this.path, this.barrelFile));
  }
}
