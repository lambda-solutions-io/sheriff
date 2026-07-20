import { FsPath } from './fs-path';

/**
 * Represents a TypeScript file with its dependencies but does
 * not yet have an assignment to a module.
 *
 * After module assignment is done, it becomes a type `FileInfo`.
 *
 * If an import cannot be resolved, it doesn't throw an error
 * but is added to unresolvableImports.
 *
 * It is up to the consumer, e.g. ESLinter, to decide if that
 * should cause an error or not.
 */
export class UnassignedFileInfo {
  #importEdges: UnassignedImportEdge[] = [];
  #unresolvableImports: string[] = [];
  #externalLibraries: string[] = [];

  constructor(
    public path: FsPath,
    public imports: UnassignedFileInfo[] = [],
  ) {}

  addUnresolvableImport(importCommand: string) {
    this.#unresolvableImports.push(importCommand);
  }

  get unresolvableImports() {
    return [...this.#unresolvableImports];
  }

  isUnresolvableImport(importCommand: string) {
    return this.#unresolvableImports.includes(importCommand);
  }

  hasUnresolvableImports() {
    return this.#unresolvableImports.length > 0;
  }

  addImport(importedFileInfo: UnassignedFileInfo, rawImport: string) {
    this.imports.push(importedFileInfo);
    this.#importEdges.push({ importedFileInfo, rawImport });
  }

  /**
   * Every resolved import in source order, including multiple raw specifiers
   * which resolve to the same file.
   */
  get importEdges(): ReadonlyArray<Readonly<UnassignedImportEdge>> {
    return this.#importEdges;
  }

  addExternalLibrary(libraryImport: string) {
    if (this.#externalLibraries.includes(libraryImport)) {
      return;
    }

    this.#externalLibraries.push(libraryImport);
  }

  getExternalLibraries(): Readonly<string[]> {
    return [...this.#externalLibraries] as const;
  }
}

export type UnassignedImportEdge = {
  importedFileInfo: UnassignedFileInfo;
  rawImport: string;
};
