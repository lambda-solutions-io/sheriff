import { checkForDependencyRuleViolation } from '../lib/checks/check-for-dependency-rule-violation';
import { checkForExternalRuleViolation } from '../lib/checks/check-for-external-rule-violation';
import { hasEncapsulationViolations } from '../lib/checks/has-encapsulation-violations';
import { parseConfig } from '../lib/config/parse-config';
import { FsPath, toFsPath } from '../lib/file-info/fs-path';
import getFs from '../lib/fs/getFs';
import { init, ProjectInfo } from '../lib/main/init';
import { FileInfo } from '../lib/modules/file.info';
import { traverseFileInfo } from '../lib/modules/traverse-file-info';
import { calcTagsForModule } from '../lib/tags/calc-tags-for-module';

export type EngineOracle = {
  version: 1;
  rootDir: string;
  files: EngineOracleFile[];
  modules: EngineOracleModule[];
  violations: {
    dependency: EngineOracleDependencyViolation[];
    encapsulation: EngineOracleEncapsulationViolation[];
    external: EngineOracleExternalViolation[];
  };
};

export type EngineOracleFile = {
  path: string;
  module: string;
  imports: EngineOracleImport[];
};

export type EngineOracleImport = {
  raw: string;
  resolvedPath: string | null;
  kind: 'module' | 'external' | 'unresolvable';
};

export type EngineOracleModule = {
  path: string;
  tags: string[];
  isBarrel: boolean;
};

export type EngineOracleDependencyViolation = {
  file: string;
  rawImport: string;
  fromModulePath: string;
  toModulePath: string;
  toFilePath: string;
  fromTag: string;
  toTags: string[];
  cause?: 'deny-rule';
};

export type EngineOracleEncapsulationViolation = {
  file: string;
  rawImport: string;
  toFilePath: string;
};

export type EngineOracleExternalViolation = {
  file: string;
  externalLibrary: string;
  fromTag: string;
};

/**
 * Generates a stable, machine-independent representation of Sheriff's engine
 * output for one project entry file.
 *
 * A directory input must contain `sheriff.config.ts` with exactly one entry.
 */
export function generateOracle(entryFileOrConfigDir: string): EngineOracle {
  const entryFile = resolveEntryFile(entryFileOrConfigDir);
  const projectInfo = init(entryFile);
  const files = [...traverseFileInfo(projectInfo.fileInfo)].map(
    ({ fileInfo }) => fileInfo,
  );

  return {
    version: 1,
    rootDir: relativePath(projectInfo.rootDir, projectInfo.rootDir),
    files: sortRecords(
      files.map((fileInfo) => createFileEntry(fileInfo, projectInfo.rootDir)),
    ),
    modules: sortRecords(
      projectInfo.modules.map((moduleInfo) => ({
        path: relativePath(projectInfo.rootDir, moduleInfo.path),
        tags: calcTagsForModule(
          moduleInfo.path,
          projectInfo.rootDir,
          projectInfo.config.modules,
          projectInfo.config.autoTagging,
        ).sort(compareStrings),
        isBarrel: moduleInfo.hasBarrel,
      })),
    ),
    violations: createViolations(files, projectInfo),
  };
}

function resolveEntryFile(entryFileOrConfigDir: string): FsPath {
  const fs = getFs();
  const absoluteInput = fs.isAbsolute(entryFileOrConfigDir)
    ? entryFileOrConfigDir
    : fs.join(fs.cwd(), entryFileOrConfigDir);
  const inputPath = toFsPath(absoluteInput);

  if (fs.isFile(inputPath)) {
    return inputPath;
  }

  const configPath = toFsPath(fs.join(inputPath, 'sheriff.config.ts'));
  const config = parseConfig(configPath);
  const configuredEntries = config.entryFile
    ? [config.entryFile]
    : Object.values(config.entryPoints ?? {});

  if (configuredEntries.length !== 1) {
    throw new Error(
      'A config directory must define exactly one entryFile or entryPoint.',
    );
  }

  return toFsPath(fs.join(inputPath, configuredEntries[0]));
}

function createFileEntry(
  fileInfo: FileInfo,
  rootDir: FsPath,
): EngineOracleFile {
  const resolvedImports: EngineOracleImport[] = fileInfo.importEdges.map(
    ({ importedFileInfo, rawImport }) => ({
      raw: rawImport,
      resolvedPath: relativePath(rootDir, importedFileInfo.path),
      kind: 'module',
    }),
  );
  const externalImports: EngineOracleImport[] = fileInfo
    .getExternalLibraries()
    .map((raw) => ({ raw, resolvedPath: null, kind: 'external' }));
  const unresolvableImports: EngineOracleImport[] = fileInfo.unresolvableImports.map(
    (raw) => ({ raw, resolvedPath: null, kind: 'unresolvable' }),
  );

  return {
    path: relativePath(rootDir, fileInfo.path),
    module: relativePath(rootDir, fileInfo.moduleInfo.path),
    imports: sortRecords([
      ...resolvedImports,
      ...externalImports,
      ...unresolvableImports,
    ]),
  };
}

function createViolations(
  files: FileInfo[],
  projectInfo: ProjectInfo,
): EngineOracle['violations'] {
  const dependency: EngineOracleDependencyViolation[] = [];
  const encapsulation: EngineOracleEncapsulationViolation[] = [];
  const external: EngineOracleExternalViolation[] = [];

  for (const fileInfo of files) {
    for (const violation of checkForDependencyRuleViolation(
      fileInfo.path,
      projectInfo,
    )) {
      const entry: EngineOracleDependencyViolation = {
        file: relativePath(projectInfo.rootDir, fileInfo.path),
        rawImport: violation.rawImport,
        fromModulePath: relativePath(
          projectInfo.rootDir,
          violation.fromModulePath,
        ),
        toModulePath: relativePath(
          projectInfo.rootDir,
          violation.toModulePath,
        ),
        toFilePath: relativePath(projectInfo.rootDir, violation.toFilePath),
        fromTag: violation.fromTag,
        toTags: [...violation.toTags].sort(compareStrings),
      };
      if (violation.cause !== undefined) {
        entry.cause = violation.cause;
      }
      dependency.push(entry);
    }

    for (const [rawImport, importedFileInfo] of Object.entries(
      hasEncapsulationViolations(fileInfo.path, projectInfo),
    )) {
      encapsulation.push({
        file: relativePath(projectInfo.rootDir, fileInfo.path),
        rawImport,
        toFilePath: relativePath(projectInfo.rootDir, importedFileInfo.path),
      });
    }

    for (const violation of checkForExternalRuleViolation(
      fileInfo.path,
      projectInfo,
    )) {
      external.push({
        file: relativePath(projectInfo.rootDir, fileInfo.path),
        externalLibrary: violation.externalLibrary,
        fromTag: violation.fromTag,
      });
    }
  }

  return {
    dependency: sortRecords(dependency),
    encapsulation: sortRecords(encapsulation),
    external: sortRecords(external),
  };
}

function relativePath(rootDir: FsPath, path: FsPath): string {
  return (getFs().relativeTo(rootDir, path) || '.').replaceAll('\\', '/');
}

function sortRecords<T>(records: T[]): T[] {
  return records.sort((left, right) =>
    compareStrings(JSON.stringify(left), JSON.stringify(right)),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
