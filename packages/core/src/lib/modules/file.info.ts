import { UnassignedFileInfo } from '../file-info/unassigned-file-info';
import { Module } from './module';
import { FsPath } from '../file-info/fs-path';

/**
 * Central element representing a TypeScript file with its
 * imports and assigned module.
 *
 * Due to ESLint, we can have partial imports while a developer is typing.
 */
export class FileInfo {
  #imports: FileInfo[] | undefined;
  #importEdges: FileInfoImportEdge[] | undefined;

  constructor(
    private unassignedFileInfo: UnassignedFileInfo,
    public moduleInfo: Module,
    private getFileInfo: (fsPath: FsPath) => FileInfo,
  ) {}

  get path(): FsPath {
    return this.unassignedFileInfo.path;
  }

  get imports(): FileInfo[] {
    if (this.#imports === undefined) {
      this.#imports = this.unassignedFileInfo.imports.map(
        (unassignedFileInfo) => this.getFileInfo(unassignedFileInfo.path),
      );
    }
    return this.#imports;
  }

  /**
   * Every resolved import in source order, including multiple raw specifiers
   * which resolve to the same file.
   */
  get importEdges(): ReadonlyArray<Readonly<FileInfoImportEdge>> {
    if (this.#importEdges === undefined) {
      this.#importEdges = this.unassignedFileInfo.importEdges.map(
        ({ importedFileInfo, rawImport }) => ({
          importedFileInfo: this.getFileInfo(importedFileInfo.path),
          rawImport,
        }),
      );
    }
    return this.#importEdges;
  }

  get unresolvableImports() {
    return this.unassignedFileInfo.unresolvableImports;
  }

  isUnresolvableImport(importCommand: string) {
    return this.unassignedFileInfo.isUnresolvableImport(importCommand);
  }

  hasUnresolvedImports() {
    return this.unassignedFileInfo.hasUnresolvableImports();
  }

  getExternalLibraries() {
    return this.unassignedFileInfo.getExternalLibraries();
  }
}

export type FileInfoImportEdge = {
  importedFileInfo: FileInfo;
  rawImport: string;
};
