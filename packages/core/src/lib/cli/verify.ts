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
import { FsPath, toFsPath } from '../file-info/fs-path';
import { Fs } from '../fs/fs';
import { buildEngineProjectInput } from '../engine/build-engine-project-input';
import {
  logEngineFallback,
  runEngineProject,
} from '../engine/run-engine-project';
import type {
  EngineDependencyViolation,
  EngineEncapsulationViolation,
  EngineExternalViolation,
  EngineOutput,
} from '@lambda-solutions/sheriff-engine';
import { calcTagsForModule } from '../tags/calc-tags-for-module';

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

export function verify(args: string[], options: { files?: string[] } = {}) {
  const fs = getFs();
  const projectEntries = getEntriesFromCliOrConfig(args[0]);
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
      for (const { fileInfo } of traverseFileInfo(
        projectEntry.projectInfo.fileInfo,
      )) {
        // Canonicalize graph paths too, so both sides of the comparison
        // are in the same canonical form.
        const canonicalPath = canonicalize(fileInfo.path, fs);
        knownFilePaths.set(canonicalPath, fileInfo.path);
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
      const engineValidation = tryRunEngineChecksForProject(
        projectEntry.entryFile,
        projectEntry.projectInfo,
        fileInfoPaths,
        fs,
      );

      if (engineValidation) {
        projectValidations.set(projectEntry.projectName, engineValidation);
        if (engineValidation.hasError) {
          hasAnyProjectError = true;
        }
        continue;
      }

      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;

      for (const fileInfoPath of fileInfoPaths) {
        if (
          runChecksForFile(
            fileInfoPath,
            projectEntry.projectInfo,
            projectValidation,
            fs,
          )
        ) {
          hasAnyProjectError = true;
        }
      }
    }
  } else {
    for (const projectEntry of projectEntries) {
      const fileInfoPaths = [
        ...traverseFileInfo(projectEntry.projectInfo.fileInfo),
      ].map(({ fileInfo }) => fileInfo.path);
      const engineValidation = tryRunEngineChecksForProject(
        projectEntry.entryFile,
        projectEntry.projectInfo,
        fileInfoPaths,
        fs,
      );

      if (engineValidation) {
        projectValidations.set(projectEntry.projectName, engineValidation);
        if (engineValidation.hasError) {
          hasAnyProjectError = true;
        }
        continue;
      }

      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;

      for (const fileInfoPath of fileInfoPaths) {
        if (
          runChecksForFile(
            fileInfoPath,
            projectEntry.projectInfo,
            projectValidation,
            fs,
          )
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

function tryRunEngineChecksForProject(
  entryFile: string,
  projectInfo: ProjectInfo,
  fileInfoPaths: FsPath[],
  fs: Fs,
): ProjectValidation | undefined {
  if (process.env['SHERIFF_ENGINE'] !== '1' || fileInfoPaths.length === 0) {
    return undefined;
  }

  try {
    const output = runEngineProject(
      buildEngineProjectInput(projectInfo, entryFile),
    );
    if (!output) {
      return undefined;
    }

    const validation = createProjectValidation();
    applyEngineChecksForFiles(
      output,
      fileInfoPaths,
      projectInfo,
      validation,
      fs,
    );
    return validation;
  } catch (error) {
    logEngineFallback(error);
    return undefined;
  }
}

type EngineViolationsForFile = {
  dependency: EngineDependencyViolation[];
  encapsulation: EngineEncapsulationViolation[];
  external: EngineExternalViolation[];
};

function applyEngineChecksForFiles(
  output: EngineOutput,
  fileInfoPaths: FsPath[],
  projectInfo: ProjectInfo,
  projectValidation: ProjectValidation,
  fs: Fs,
): void {
  const violationsByFile = indexEngineViolations(output);
  assertEngineViolationFilesAreKnown(violationsByFile, projectInfo);

  for (const fileInfoPath of fileInfoPaths) {
    const violations = violationsByFile.get(
      relativeEnginePath(projectInfo.rootDir, fileInfoPath),
    ) ?? { dependency: [], encapsulation: [], external: [] };
    const fileInfo = projectInfo.getFileInfo(fileInfoPath);
    const encapsulations = orderEngineEncapsulations(
      violations.encapsulation,
      fileInfo.importEdges,
      projectInfo.rootDir,
    );
    const dependencyRuleViolations = orderEngineDependencyViolations(
      violations.dependency,
      fileInfo.importEdges,
      projectInfo,
    );
    const externalRuleViolations = orderEngineExternalViolations(
      violations.external,
      fileInfo.getExternalLibraries(),
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
  projectInfo: ProjectInfo,
): void {
  const knownFiles = new Set(
    [...traverseFileInfo(projectInfo.fileInfo)].map(({ fileInfo }) =>
      relativeEnginePath(projectInfo.rootDir, fileInfo.path),
    ),
  );
  for (const file of violationsByFile.keys()) {
    if (!knownFiles.has(file)) {
      throw new Error(`Engine returned a violation for unknown file ${file}.`);
    }
  }
}

function orderEngineEncapsulations(
  violations: EngineEncapsulationViolation[],
  importEdges: ReturnType<ProjectInfo['getFileInfo']>['importEdges'],
  rootDir: FsPath,
): string[] {
  const unmatched = new Set(violations);
  const encapsulations: Record<string, true> = {};

  for (const edge of importEdges) {
    const violation = [...unmatched].find(
      (candidate) =>
        candidate.rawImport === edge.rawImport &&
        candidate.toFilePath ===
          relativeEnginePath(rootDir, edge.importedFileInfo.path),
    );
    if (violation) {
      unmatched.delete(violation);
      encapsulations[edge.rawImport] = true;
    }
  }
  assertNoUnmatchedEngineViolations(unmatched.size, 'encapsulation');
  return Object.keys(encapsulations);
}

function orderEngineDependencyViolations(
  violations: EngineDependencyViolation[],
  importEdges: ReturnType<ProjectInfo['getFileInfo']>['importEdges'],
  projectInfo: ProjectInfo,
): DependencyRuleViolation[] {
  const remaining = [...violations];
  const ordered: EngineDependencyViolation[] = [];

  for (const edge of importEdges) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.rawImport === edge.rawImport &&
        candidate.toFilePath ===
          relativeEnginePath(projectInfo.rootDir, edge.importedFileInfo.path),
    );
    if (index !== -1) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }
  assertNoUnmatchedEngineViolations(remaining.length, 'dependency');

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
  externalLibraries: readonly string[],
): EngineExternalViolation[] {
  const remaining = [...violations];
  const ordered: EngineExternalViolation[] = [];

  for (const externalLibrary of externalLibraries) {
    const index = remaining.findIndex(
      (candidate) => candidate.externalLibrary === externalLibrary,
    );
    if (index !== -1) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }
  assertNoUnmatchedEngineViolations(remaining.length, 'external');
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

function logAppliedConfig(projectInfo: ProjectInfo): void {
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
