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
  barrelFile: string;
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
    private readonly hasBarrel: boolean,
    private readonly exposureConfig: ModuleExposureConfig,
  ) {}

  addFileInfo(unassignedFileInfo: UnassignedFileInfo) {
    const fileInfo = new FileInfo(unassignedFileInfo, this, this.getFileInfo);
    this.fileInfoMap.set(fileInfo.path, fileInfo);
    this.fileInfos.push(fileInfo);
  }

  get barrelPath(): FsPath {
    return toFsPath(getFs().join(this.path, this.exposureConfig.barrelFile));
  }

  /**
   * Whether this module owns a barrel file — nothing more. In particular
   * `'barrel-less'` does **not** imply that the module exposes anything: a
   * module without a barrel outside barrel-less mode (e.g. the root module)
   * also reports `'barrel-less'` while exposing nothing.
   *
   * Only for user-facing output (messages, project data). Access checks must
   * go through `exposes`, which is why `hasBarrel` itself is private.
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
   * - module without barrel while `enableBarrelLess` is off: nothing. The
   *   root module is such a case only in that mode — with `enableBarrelLess`
   *   on it has no barrel either and is judged like any barrel-less module.
   *
   * Import-context concerns (same-module imports, `excludeRoot`) stay with
   * the callers — they are properties of the import, not of the module.
   *
   * A file outside this module is never exposed by it. Without that guard the
   * barrel-less branch would fail *open*: a relative path leading out of the
   * module (`../other/internal/x.ts`) matches no encapsulation pattern and
   * would be reported as publicly importable.
   */
  exposes(fileInfo: FileInfo): boolean {
    if (this.hasBarrel) {
      return (
        normalizePathSeparators(fileInfo.path) ===
        normalizePathSeparators(this.barrelPath)
      );
    }

    if (!this.exposureConfig.enableBarrelLess) {
      return false;
    }

    const relativePath = normalizePathSeparators(
      getFs().relativeTo(this.path, fileInfo.path),
    );

    if (relativePath === '..' || relativePath.startsWith('../')) {
      return false;
    }

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
