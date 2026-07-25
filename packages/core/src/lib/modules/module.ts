import { UnassignedFileInfo } from '../file-info/unassigned-file-info';
import { FileInfo } from './file.info';
import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import {
  matchesFilePathPattern,
  normalizePathSeparators,
} from './internal/segment-pattern';

/**
 * Project-level settings a module needs to answer `exposes` on its own.
 */
export interface ModuleExposureConfig {
  enableBarrelLess: boolean;
  encapsulationPattern: string | RegExp;
}

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
    private readonly exposureConfig: ModuleExposureConfig,
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

  /**
   * How this module defines its public surface. Only relevant for
   * user-facing output (messages, project data) — access checks should go
   * through `exposes` instead of branching on the kind.
   */
  get kind(): 'barrel' | 'barrel-less' {
    return this.hasBarrel ? 'barrel' : 'barrel-less';
  }

  /**
   * Whether `fileInfo` (a file of this module) is importable from outside
   * the module.
   *
   * This is the single place deciding a module's public surface:
   *
   * - barrel module: only the barrel file itself
   * - barrel-less module (`enableBarrelLess`): every file except those
   *   matching the encapsulation pattern, or — if `exportedFilePatterns`
   *   is set — only files matching one of those patterns
   * - module without barrel outside barrel-less mode (e.g. the root
   *   module): nothing
   *
   * Import-context concerns (same-module imports, `excludeRoot`) stay with
   * the callers — they are properties of the import, not of the module.
   */
  exposes(fileInfo: FileInfo): boolean {
    if (this.hasBarrel) {
      return fileInfo.path === this.barrelPath;
    }

    if (!this.exposureConfig.enableBarrelLess) {
      return false;
    }

    const relativePath = normalizePathSeparators(
      getFs().relativeTo(this.path, fileInfo.path),
    );

    if (this.exportedFilePatterns !== undefined) {
      return this.exportedFilePatterns.some((exportPattern) =>
        matchesFilePathPattern(exportPattern, relativePath),
      );
    }

    const { encapsulationPattern } = this.exposureConfig;
    if (typeof encapsulationPattern === 'string') {
      return !relativePath.startsWith(encapsulationPattern);
    }
    return !relativePath.match(encapsulationPattern);
  }
}
