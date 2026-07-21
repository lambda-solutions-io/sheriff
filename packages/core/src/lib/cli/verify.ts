import { hasEncapsulationViolations } from '../checks/has-encapsulation-violations';
import { traverseFileInfo } from '../modules/traverse-file-info';
import {
  checkForDependencyRuleViolation,
  DependencyRuleViolation,
} from '../checks/check-for-dependency-rule-violation';
import getFs from '../fs/getFs';
import { cli } from './cli';
import {
  DEFAULT_PROJECT_NAME,
  getEntriesFromCliOrConfig,
} from './internal/get-entries-from-cli-or-config';
import { logInfoForMissingSheriffConfig } from './internal/log-info-for-missing-sheriff-config';
import {
  checkForExternalRuleViolation,
  ExternalRuleViolation,
} from '../checks/check-for-external-rule-violation';
import { ProjectInfo } from '../main/init';
import { init } from '../main/init';
import {
  ResolvedProjectConfig,
  resolveProjectConfig,
} from '../main/resolve-project-config';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { Fs } from '../fs/fs';
import { buildEngineProjectInputFromConfig } from '../engine/build-engine-project-input';
import {
  loadEnginePackage,
  logEngineFallback,
} from '../engine/run-engine-project';
import type {
  EngineDependencyViolation,
  EngineEncapsulationViolation,
  EngineExternalViolation,
  EngineFile,
  EngineModulePath,
  EngineOutput,
} from '@lambda-solutions/sheriff-engine';
import { calcTagsForModule } from '../tags/calc-tags-for-module';
import { findModulePaths, ModulePathMap } from '../modules/find-module-paths';
import type { Entry } from './internal/entry';

type ValidationsMap = Record<
  string,
  {
    encapsulations: string[];
    dependencyRules: string[];
    externalRules: string[];
  }
>;

type ProjectValidation = {
  deepImportsCount: number;
  dependencyRulesCount: number;
  externalRulesCount: number;
  filesCount: number;
  hasError: boolean;
  validationsMap: ValidationsMap;
  encapsulations: string[];
  dependencyRuleViolations: DependencyRuleViolation[];
};

type PreparedProjectEntry = Entry & {
  projectInfo: ProjectInfo | ResolvedProjectConfig;
  engineOutput?: EngineOutput;
  engineValidation?: ProjectValidation;
  fileInfoPaths: FsPath[];
};

export function verify(args: string[], options: { files?: string[] } = {}) {
  const fs = getFs();
  const projectEntries = prepareProjectEntries(args[0], fs);
  logInfoForMissingSheriffConfig(projectEntries[0].projectInfo);

  // Keep track of overall status to determine final process exit code
  let hasAnyProjectError = false;

  // Store validation results for each project
  const projectValidations = new Map<string, ProjectValidation>();

  for (const projectEntry of projectEntries) {
    projectValidations.set(projectEntry.projectName, createProjectValidation());
  }

  if (options.files) {
    if (options.files.length === 0) {
      // `--files` was supplied but resolved to zero files (e.g. no changed
      // TS files in a hook). Short-circuit to a successful no-op instead of
      // falling through to a full-project verification.
      cli.log('No files to verify.');
      cli.endProcessOk();
      return;
    }

    // Canonicalize each requested path so membership is compared by file
    // identity, not raw byte-string equality. Without this, an
    // equivalent-but-different string (macOS /tmp vs /private/tmp symlink,
    // a symlinked workspace, or case-insensitive-FS casing) would miss the
    // graph and be silently skipped -> false pass in a pre-commit gate.
    const requestedFilePaths = Array.from(
      new Set(
        options.files.map((file) =>
          canonicalize(resolveFilePath(file, fs), fs),
        ),
      ),
    );
    const projectFilePaths = new Map<string, Map<string, FsPath>>();
    const allKnownFilePaths = new Set<string>();

    for (const projectEntry of projectEntries) {
      const knownFilePaths = new Map<string, FsPath>();
      for (const fileInfoPath of projectEntry.fileInfoPaths) {
        // Canonicalize graph paths too, so both sides of the comparison
        // are in the same canonical form.
        const canonicalPath = canonicalize(fileInfoPath, fs);
        knownFilePaths.set(canonicalPath, fileInfoPath);
        allKnownFilePaths.add(canonicalPath);
      }
      projectFilePaths.set(projectEntry.projectName, knownFilePaths);
    }

    const validRequestedFilePaths = requestedFilePaths.filter(
      (requestedFilePath) => {
        if (allKnownFilePaths.has(requestedFilePath)) {
          return true;
        }

        const relativePath = fs.relativeTo(fs.cwd(), requestedFilePath);
        if (fs.exists(requestedFilePath)) {
          // The file exists on disk but is not in the project graph. In a
          // pre-commit gate this almost always means a resolution bug or a
          // brand-new file the user expects to be checked. Silently passing
          // is dangerous, so treat it as an error rather than a skip.
          cli.log(
            `Error: ${relativePath} exists on disk but is not part of the project graph.`,
          );
          hasAnyProjectError = true;
        } else {
          // The file does not exist (deleted/renamed). Skipping is benign.
          cli.log(`Warning: ${relativePath} does not exist; skipping.`);
        }
        return false;
      },
    );

    for (const projectEntry of projectEntries) {
      const knownFilePaths = projectFilePaths.get(projectEntry.projectName)!;
      const fileInfoPaths = validRequestedFilePaths.flatMap(
        (requestedFilePath) => {
          const fileInfoPath = knownFilePaths.get(requestedFilePath);
          return fileInfoPath ? [fileInfoPath] : [];
        },
      );
      if (projectEntry.engineOutput) {
        const engineValidation = createEngineProjectValidation(
          projectEntry.engineOutput,
          fileInfoPaths,
          projectEntry.projectInfo as ResolvedProjectConfig,
          fs,
        );
        projectValidations.set(projectEntry.projectName, engineValidation);
        if (engineValidation.hasError) {
          hasAnyProjectError = true;
        }
        continue;
      }

      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;
      const projectInfo = projectEntry.projectInfo as ProjectInfo;

      for (const fileInfoPath of fileInfoPaths) {
        if (
          runChecksForFile(fileInfoPath, projectInfo, projectValidation, fs)
        ) {
          hasAnyProjectError = true;
        }
      }
    }
  } else {
    for (const projectEntry of projectEntries) {
      const { fileInfoPaths } = projectEntry;
      if (projectEntry.engineOutput) {
        const engineValidation = projectEntry.engineValidation!;
        projectValidations.set(projectEntry.projectName, engineValidation);
        if (engineValidation.hasError) {
          hasAnyProjectError = true;
        }
        continue;
      }

      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;
      const projectInfo = projectEntry.projectInfo as ProjectInfo;

      for (const fileInfoPath of fileInfoPaths) {
        if (
          runChecksForFile(fileInfoPath, projectInfo, projectValidation, fs)
        ) {
          hasAnyProjectError = true;
        }
      }
    }
  }

  cli.log('');
  cli.log(cli.bold('Verification Report'));

  // Process each project's validation results
  for (const [projectName, validation] of projectValidations.entries()) {
    const projectInfo = projectEntries.find(
      (entry) => entry.projectName === projectName,
    )!.projectInfo;
    cli.log('');
    if (projectName !== DEFAULT_PROJECT_NAME) {
      cli.log(cli.bold(`Project: ${projectName}`));
      cli.log('');
    }
    logAppliedConfig(projectInfo);

    if (validation.hasError) {
      cli.log('Issues found:');
      cli.log(`  Total Invalid Files: ${validation.filesCount}`);
      cli.log(
        `  Total Encapsulation Violations: ${validation.deepImportsCount}`,
      );
      cli.log(
        `  Total Dependency Rule Violations: ${validation.dependencyRulesCount}`,
      );
      if (validation.externalRulesCount > 0) {
        cli.log(
          `  Total External Rule Violations: ${validation.externalRulesCount}`,
        );
      }
      cli.log('----------------------------------');
      cli.log('');

      // Display detailed validation information for this project
      for (const [
        file,
        { encapsulations, dependencyRules, externalRules },
      ] of Object.entries(validation.validationsMap)) {
        cli.log('|-- ' + file);
        if (encapsulations.length > 0) {
          cli.log('|   |-- Encapsulation Violations');
          encapsulations.forEach((encapsulation) => {
            cli.log('|   |   |-- ' + encapsulation);
          });
        }

        if (dependencyRules.length > 0) {
          cli.log('|   |-- Dependency Rule Violations');
          dependencyRules.forEach((dependencyRule) => {
            cli.log('|   |   |-- ' + dependencyRule);
          });
        }

        if (externalRules.length > 0) {
          cli.log('|   |-- External Rule Violations');
          externalRules.forEach((externalRule) => {
            cli.log('|   |   |-- ' + externalRule);
          });
        }
      }
    } else {
      if (projectValidations.size > 1) {
        cli.log('');
        cli.log(
          '\u001b[32mNo issues found for this project. Well done!\u001b[0m',
        );
      } else {
        cli.log('\u001b[32mNo issues found. Well done!\u001b[0m');
      }
    }
  }

  // End process based on overall status
  if (hasAnyProjectError) {
    cli.endProcessError();
  } else {
    if (projectValidations.size > 1) {
      cli.log('');
      cli.log('\u001b[32mAll projects validated successfully!\u001b[0m');
    }
    cli.endProcessOk();
  }
}

function prepareProjectEntries(
  entryFileOrEntryPoints: string | undefined,
  fs: Fs,
): PreparedProjectEntry[] {
  if (process.env['SHERIFF_ENGINE'] !== '1') {
    return getEntriesFromCliOrConfig(entryFileOrEntryPoints).map((entry) => ({
      ...entry,
      fileInfoPaths: [...traverseFileInfo(entry.projectInfo.fileInfo)].map(
        ({ fileInfo }) => fileInfo.path,
      ),
    }));
  }

  return getEntriesFromCliOrConfig(entryFileOrEntryPoints, false).map((entry) =>
    prepareEngineProjectEntry(entry, fs),
  );
}

function prepareEngineProjectEntry(entry: Entry, fs: Fs): PreparedProjectEntry {
  const absoluteEntryFile = toFsPath(fs.join(fs.cwd(), entry.entryFile));
  try {
    const projectConfig = resolveProjectConfig(absoluteEntryFile);
    const handle = new (loadEnginePackage().ProjectHandle)(
      buildEngineProjectInputFromConfig(projectConfig, entry.entryFile, []),
    );
    parseEngineOutput(handle.getResult());
    const reachedPaths = parseReachedFiles(handle.getReachedFiles());
    const modulePaths = createEngineModulePaths(reachedPaths, projectConfig);
    const output = parseEngineOutput(handle.setModulePaths(modulePaths));
    assertReachedFilesMatchOutput(reachedPaths, output);
    const reportPaths = orderReachedFilesForReport(
      reachedPaths,
      output,
      relativeEnginePath(projectConfig.rootDir, absoluteEntryFile),
    );
    const fileInfoPaths = reachedPaths.map((path) =>
      toFsPath(fsPathFromEnginePath(projectConfig.rootDir, path)),
    );
    const reportFileInfoPaths = reportPaths.map((path) =>
      toFsPath(fsPathFromEnginePath(projectConfig.rootDir, path)),
    );

    // Validate every adapter invariant before `--files` membership is decided.
    // Any unmappable violation or tag divergence therefore takes the complete
    // project through the original TypeScript path.
    const engineValidation = createEngineProjectValidation(
      output,
      reportFileInfoPaths,
      projectConfig,
      fs,
    );

    return {
      ...entry,
      projectInfo: projectConfig,
      engineOutput: output,
      engineValidation,
      fileInfoPaths,
    };
  } catch (error) {
    logEngineFallback(error);
    const projectInfo = init(absoluteEntryFile);
    return {
      ...entry,
      projectInfo,
      fileInfoPaths: [...traverseFileInfo(projectInfo.fileInfo)].map(
        ({ fileInfo }) => fileInfo.path,
      ),
    };
  }
}

function parseReachedFiles(serialized: string): string[] {
  const output = JSON.parse(serialized) as unknown;
  if (
    !output ||
    typeof output !== 'object' ||
    !('schemaVersion' in output) ||
    output.schemaVersion !== 1 ||
    !('files' in output) ||
    !Array.isArray(output.files) ||
    !output.files.every((file) => typeof file === 'string')
  ) {
    throw new Error('Engine returned an invalid reached-files result.');
  }
  return output.files;
}

function parseEngineOutput(serialized: string): EngineOutput {
  const output = JSON.parse(serialized) as unknown;
  assertEngineOutput(output);
  return output;
}

function assertEngineOutput(output: unknown): asserts output is EngineOutput {
  if (!output || typeof output !== 'object') {
    throw new Error('Engine returned an invalid project result.');
  }
  if ('error' in output) {
    const error = output.error as { code?: unknown; message?: unknown };
    throw new Error(`${String(error.code)}: ${String(error.message)}`);
  }
  if (
    !('schemaVersion' in output) ||
    output.schemaVersion !== 1 ||
    !('files' in output) ||
    !Array.isArray(output.files) ||
    !('violations' in output)
  ) {
    throw new Error('Engine returned an invalid project result.');
  }
}

function createEngineModulePaths(
  reachedPaths: string[],
  projectConfig: ResolvedProjectConfig,
): EngineModulePath[] {
  const projectDirs = getProjectDirsFromReachedFiles(
    reachedPaths,
    projectConfig.rootDir,
  );
  const modulePathMap = findModulePaths(
    projectDirs,
    projectConfig.rootDir,
    projectConfig.config,
  );
  return engineModulePathsFromMap(modulePathMap, projectConfig.rootDir);
}

function getProjectDirsFromReachedFiles(
  reachedPaths: string[],
  rootDir: FsPath,
): FsPath[] {
  const fs = getFs();
  const rootDirPartsLength = fs.split(rootDir).length;
  const projectDirs = new Set<FsPath>();

  for (const reachedPath of reachedPaths) {
    const path = toFsPath(fsPathFromEnginePath(rootDir, reachedPath));
    if (!path.startsWith(rootDir)) {
      throw new Error(`file ${path} is outside of root directory: ${rootDir}`);
    }
    if (fs.getParent(path) === rootDir) {
      return [rootDir];
    }

    const projectDirPart = fs.split(path)[rootDirPartsLength];
    if (!projectDirPart) {
      throw new Error(`could not derive project directory for ${path}`);
    }
    projectDirs.add(toFsPath(fs.join(rootDir, projectDirPart)));
  }

  return Array.from(projectDirs);
}

function engineModulePathsFromMap(
  modulePathMap: ModulePathMap,
  rootDir: FsPath,
): EngineModulePath[] {
  return Object.entries(modulePathMap).flatMap(
    ([absolutePath, rawModulePathInfo]) => {
      const path = relativeEnginePath(rootDir, toFsPath(absolutePath));
      if (path === '.') {
        return [];
      }
      const modulePathInfo =
        typeof rawModulePathInfo === 'boolean'
          ? { hasBarrel: rawModulePathInfo }
          : rawModulePathInfo;
      return [
        {
          path,
          isBarrel: modulePathInfo.hasBarrel,
          ...(modulePathInfo.exports === undefined
            ? {}
            : { exports: modulePathInfo.exports }),
        },
      ];
    },
  );
}

function assertReachedFilesMatchOutput(
  reachedPaths: string[],
  output: EngineOutput,
): void {
  const reached = new Set(reachedPaths);
  const outputPaths = new Set(output.files.map(({ path }) => path));
  if (
    reached.size !== reachedPaths.length ||
    outputPaths.size !== output.files.length ||
    reached.size !== outputPaths.size ||
    [...reached].some((path) => !outputPaths.has(path))
  ) {
    throw new Error(
      'Engine reached-files result does not match project output.',
    );
  }
}

function orderReachedFilesForReport(
  reachedPaths: string[],
  output: EngineOutput,
  entryPath: string,
): string[] {
  const reached = new Set(reachedPaths);
  const filesByPath = new Map(output.files.map((file) => [file.path, file]));
  if (!reached.has(entryPath)) {
    throw new Error(`Engine result omitted entry file ${entryPath}.`);
  }

  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (path: string): void => {
    if (visited.has(path)) {
      return;
    }

    const file = filesByPath.get(path);
    if (!file || !Array.isArray(file.imports)) {
      throw new Error(`Engine result cannot reconstruct imports for ${path}.`);
    }

    visited.add(path);
    ordered.push(path);

    for (const importInfo of file.imports) {
      if (
        !importInfo ||
        !['module', 'external', 'unresolvable'].includes(importInfo.kind)
      ) {
        throw new Error(`Engine returned an invalid import for ${path}.`);
      }
      if (importInfo.kind !== 'module') {
        continue;
      }
      if (typeof importInfo.resolvedPath !== 'string') {
        throw new Error(
          `Engine result cannot reconstruct a module import for ${path}.`,
        );
      }
      if (reached.has(importInfo.resolvedPath)) {
        visit(importInfo.resolvedPath);
      }
    }
  };

  visit(entryPath);

  // Retain the native JS-UTF16-sorted reached set for discovery and append any
  // defensive stragglers without dropping coverage from the report.
  for (const path of reachedPaths) {
    if (!visited.has(path)) {
      ordered.push(path);
    }
  }

  return ordered;
}

function resolveFilePath(file: string, fs: Fs): string {
  const absolutePath = fs.isAbsolute(file) ? file : fs.join(fs.cwd(), file);
  return fs.join(absolutePath);
}

/**
 * Canonicalizes an absolute path so that two equivalent-but-different path
 * strings (symlink vs. real target, differing casing on a case-insensitive
 * filesystem) compare equal. Falls back to the input when the path cannot be
 * resolved (e.g. it does not exist on disk).
 */
function canonicalize(absolutePath: string, fs: Fs): string {
  return fs.realpath(absolutePath);
}

function createProjectValidation(): ProjectValidation {
  return {
    deepImportsCount: 0,
    dependencyRulesCount: 0,
    externalRulesCount: 0,
    filesCount: 0,
    hasError: false,
    validationsMap: {},
    encapsulations: [],
    dependencyRuleViolations: [],
  };
}

function createEngineProjectValidation(
  output: EngineOutput,
  fileInfoPaths: FsPath[],
  projectInfo: ResolvedProjectConfig,
  fs: Fs,
): ProjectValidation {
  const validation = createProjectValidation();
  applyEngineChecksForFiles(output, fileInfoPaths, projectInfo, validation, fs);
  return validation;
}

type EngineViolationsForFile = {
  dependency: EngineDependencyViolation[];
  encapsulation: EngineEncapsulationViolation[];
  external: EngineExternalViolation[];
};

function applyEngineChecksForFiles(
  output: EngineOutput,
  fileInfoPaths: FsPath[],
  projectInfo: ResolvedProjectConfig,
  projectValidation: ProjectValidation,
  fs: Fs,
): void {
  const violationsByFile = indexEngineViolations(output);
  assertEngineViolationFilesAreKnown(violationsByFile, output.files);
  const filesByPath = new Map(output.files.map((file) => [file.path, file]));

  for (const fileInfoPath of fileInfoPaths) {
    const enginePath = relativeEnginePath(projectInfo.rootDir, fileInfoPath);
    const file = filesByPath.get(enginePath);
    if (!file) {
      throw new Error(`Engine result omitted reached file ${enginePath}.`);
    }
    const violations = violationsByFile.get(enginePath) ?? {
      dependency: [],
      encapsulation: [],
      external: [],
    };
    const encapsulations = orderEngineEncapsulations(
      violations.encapsulation,
      file,
    );
    const dependencyRuleViolations = orderEngineDependencyViolations(
      violations.dependency,
      file,
      projectInfo,
    );
    const externalRuleViolations = orderEngineExternalViolations(
      violations.external,
      file,
    );
    projectValidation.encapsulations = encapsulations;
    projectValidation.dependencyRuleViolations = dependencyRuleViolations;

    if (
      encapsulations.length === 0 &&
      dependencyRuleViolations.length === 0 &&
      externalRuleViolations.length === 0
    ) {
      continue;
    }

    projectValidation.hasError = true;
    projectValidation.filesCount++;
    projectValidation.deepImportsCount += encapsulations.length;
    projectValidation.dependencyRulesCount += dependencyRuleViolations.length;
    projectValidation.externalRulesCount += externalRuleViolations.length;
    projectValidation.validationsMap[fs.relativeTo(fs.cwd(), fileInfoPath)] = {
      encapsulations,
      dependencyRules: dependencyRuleViolations.map(
        formatDependencyRuleViolation,
      ),
      externalRules: externalRuleViolations.map(formatExternalRuleViolation),
    };
  }
}

function indexEngineViolations(
  output: EngineOutput,
): Map<string, EngineViolationsForFile> {
  const indexed = new Map<string, EngineViolationsForFile>();
  const getEntry = (file: string) => {
    let entry = indexed.get(file);
    if (!entry) {
      entry = { dependency: [], encapsulation: [], external: [] };
      indexed.set(file, entry);
    }
    return entry;
  };

  for (const violation of output.violations.dependency) {
    getEntry(violation.file).dependency.push(violation);
  }
  for (const violation of output.violations.encapsulation) {
    getEntry(violation.file).encapsulation.push(violation);
  }
  for (const violation of output.violations.external) {
    getEntry(violation.file).external.push(violation);
  }

  return indexed;
}

function assertEngineViolationFilesAreKnown(
  violationsByFile: Map<string, EngineViolationsForFile>,
  files: EngineFile[],
): void {
  const knownFiles = new Set(files.map(({ path }) => path));
  for (const file of violationsByFile.keys()) {
    if (!knownFiles.has(file)) {
      throw new Error(`Engine returned a violation for unknown file ${file}.`);
    }
  }
}

function orderEngineEncapsulations(
  violations: EngineEncapsulationViolation[],
  file: EngineFile,
): string[] {
  const encapsulations: Record<string, true> = {};
  for (const violation of orderByImports(
    violations,
    file,
    'module',
    'encapsulation',
    (candidate, importInfo) =>
      candidate.rawImport === importInfo.raw &&
      (importInfo.resolvedPath === undefined ||
        candidate.toFilePath === importInfo.resolvedPath),
  )) {
    encapsulations[violation.rawImport] = true;
  }
  return Object.keys(encapsulations);
}

function orderEngineDependencyViolations(
  violations: EngineDependencyViolation[],
  file: EngineFile,
  projectInfo: ResolvedProjectConfig,
): DependencyRuleViolation[] {
  const ordered = orderByImports(
    violations,
    file,
    'module',
    'dependency',
    (candidate, importInfo) =>
      candidate.rawImport === importInfo.raw &&
      (importInfo.resolvedPath === undefined ||
        candidate.toFilePath === importInfo.resolvedPath),
  );

  return ordered.map((violation) => {
    const toModulePath = toFsPath(
      fsPathFromEnginePath(projectInfo.rootDir, violation.toModulePath),
    );
    const toTags = calcTagsForModule(
      toModulePath,
      projectInfo.rootDir,
      projectInfo.config.modules,
      projectInfo.config.autoTagging,
    );
    if (!haveSameValues(toTags, violation.toTags)) {
      throw new Error(
        `Engine returned incompatible tags for module ${violation.toModulePath}.`,
      );
    }

    return {
      rawImport: violation.rawImport,
      fromModulePath: toFsPath(
        fsPathFromEnginePath(projectInfo.rootDir, violation.fromModulePath),
      ),
      toModulePath,
      toFilePath: toFsPath(
        fsPathFromEnginePath(projectInfo.rootDir, violation.toFilePath),
      ),
      fromTag: violation.fromTag,
      toTags,
      ...(violation.cause ? { cause: violation.cause } : {}),
    };
  });
}

function orderEngineExternalViolations(
  violations: EngineExternalViolation[],
  file: EngineFile,
): EngineExternalViolation[] {
  return orderByImports(
    violations,
    file,
    'external',
    'external',
    (candidate, importInfo) => candidate.externalLibrary === importInfo.raw,
  );
}

function orderByImports<Violation>(
  violations: Violation[],
  file: EngineFile,
  kind: EngineFile['imports'][number]['kind'],
  category: string,
  matches: (
    violation: Violation,
    importInfo: EngineFile['imports'][number],
  ) => boolean,
): Violation[] {
  const remaining = [...violations];
  const ordered: Violation[] = [];

  for (const importInfo of file.imports) {
    if (importInfo.kind !== kind) {
      continue;
    }
    const index = remaining.findIndex((violation) =>
      matches(violation, importInfo),
    );
    if (index !== -1) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }
  assertNoUnmatchedEngineViolations(remaining.length, category);
  return ordered;
}

function assertNoUnmatchedEngineViolations(
  violationCount: number,
  category: string,
): void {
  if (violationCount > 0) {
    throw new Error(`Engine returned an unmappable ${category} violation.`);
  }
}

function haveSameValues(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function relativeEnginePath(rootDir: FsPath, path: FsPath): string {
  return (getFs().relativeTo(rootDir, path) || '.').replaceAll('\\', '/');
}

function fsPathFromEnginePath(rootDir: FsPath, path: string): string {
  return path === '.' ? rootDir : getFs().join(rootDir, path);
}

function runChecksForFile(
  fileInfoPath: FsPath,
  projectInfo: ProjectInfo,
  projectValidation: ProjectValidation,
  fs: Fs,
): boolean {
  const encapsulations = Object.keys(
    hasEncapsulationViolations(fileInfoPath, projectInfo),
  );
  const dependencyRuleViolations = checkForDependencyRuleViolation(
    fileInfoPath,
    projectInfo,
  );
  const externalRuleViolations = checkForExternalRuleViolation(
    fileInfoPath,
    projectInfo,
  );
  projectValidation.encapsulations = encapsulations;
  projectValidation.dependencyRuleViolations = dependencyRuleViolations;

  if (
    encapsulations.length === 0 &&
    dependencyRuleViolations.length === 0 &&
    externalRuleViolations.length === 0
  ) {
    return false;
  }

  projectValidation.hasError = true;
  projectValidation.filesCount++;
  projectValidation.deepImportsCount += encapsulations.length;
  projectValidation.dependencyRulesCount += dependencyRuleViolations.length;
  projectValidation.externalRulesCount += externalRuleViolations.length;

  const dependencyRules = dependencyRuleViolations.map(
    formatDependencyRuleViolation,
  );
  const externalRules = externalRuleViolations.map(formatExternalRuleViolation);
  const relativePath = fs.relativeTo(fs.cwd(), fileInfoPath);
  projectValidation.validationsMap[relativePath] = {
    encapsulations,
    dependencyRules,
    externalRules,
  };

  return true;
}

function logAppliedConfig(
  projectInfo: Pick<
    ProjectInfo,
    'usesMultipleConfigs' | 'configFilePath' | 'rootDir'
  >,
): void {
  if (!projectInfo.usesMultipleConfigs || !projectInfo.configFilePath) {
    return;
  }

  const configPath = getFs().relativeTo(
    projectInfo.rootDir,
    projectInfo.configFilePath,
  );
  cli.log(`Config: ${configPath}`);
  cli.log('');
}

function formatExternalRuleViolation(
  violation: Pick<ExternalRuleViolation, 'externalLibrary' | 'fromTag'>,
): string {
  return `external library ${violation.externalLibrary} is not allowed for tag ${violation.fromTag}`;
}

function formatDependencyRuleViolation(
  violation: Pick<DependencyRuleViolation, 'cause' | 'fromTag' | 'toTags'>,
): string {
  if (violation.cause === 'deny-rule') {
    return `denyRules denied from tag ${violation.fromTag} to tags ${violation.toTags.join(', ')}`;
  }

  return `from tag ${violation.fromTag} to tags ${violation.toTags.join(', ')}`;
}
