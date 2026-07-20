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
import { init, ProjectInfo } from '../main/init';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { Fs } from '../fs/fs';
import { EntryWithProjectInfo } from './internal/entry';

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
  if (options.files?.length === 0) {
    // `--files` was supplied but resolved to zero files (e.g. no changed
    // TS files in a hook). This must happen before any project is initialized.
    cli.log('No files to verify.');
    cli.endProcessOk();
    return;
  }

  const fs = getFs();
  let projectEntries: EntryWithProjectInfo[];
  const projectFilePaths = new Map<string, Map<string, FsPath>>();
  let hasAnyProjectError = false;

  if (options.files) {
    const entries = getEntriesFromCliOrConfig(args[0], false);

    // Canonicalize requested paths so membership is compared by file
    // identity. Graph paths are canonicalized on the other side of the
    // comparison too: absolute is not the same as canonical, and a symlink
    // anywhere on the path (macOS /tmp -> /private/tmp, symlinked workspace
    // packages) would otherwise make an owned file look missing.
    const requestedFilePaths = Array.from(
      new Set(
        options.files.map((file) =>
          canonicalize(resolveFilePath(file, fs), fs),
        ),
      ),
    );

    if (requestedFilePaths.length === 0) {
      cli.log('No files to verify.');
      cli.endProcessOk();
      return;
    }

    const requestedFilePathSet = new Set(requestedFilePaths);
    const unresolvedFilePaths = new Set<string>();
    for (const requestedFilePath of requestedFilePaths) {
      if (fs.exists(requestedFilePath)) {
        unresolvedFilePaths.add(requestedFilePath);
      } else {
        const relativePath = fs.relativeTo(fs.cwd(), requestedFilePath);
        cli.log(`Warning: ${relativePath} does not exist; skipping.`);
      }
    }

    projectEntries = [];

    // Entry points can import files outside their own directory, so ownership
    // cannot be inferred safely from path prefixes: every entry point is a
    // candidate owner and is initialized.
    //
    // A file reachable from several entry points must be checked under each
    // of them — their configs can differ, so one permissive owner must not
    // hide a violation reported by another. Ownership is therefore recorded
    // per entry point and never consumed globally.
    for (const entry of entries) {
      const projectInfo = init(toFsPath(fs.join(fs.cwd(), entry.entryFile)));
      const projectEntry = { ...entry, projectInfo };
      const knownFilePaths = new Map<string, FsPath>();

      projectEntries.push(projectEntry);
      projectFilePaths.set(entry.projectName, knownFilePaths);

      for (const { fileInfo } of traverseFileInfo(projectInfo.fileInfo)) {
        // Canonicalize the graph side as well, so both sides of the
        // comparison are in the same form.
        const canonicalPath = canonicalize(fileInfo.path, fs);
        if (requestedFilePathSet.has(canonicalPath)) {
          knownFilePaths.set(canonicalPath, fileInfo.path);
          unresolvedFilePaths.delete(canonicalPath);
        }
      }
    }

    // Only after every possible owner has been checked can an existing file
    // be reported as absent from all project graphs.
    for (const unresolvedFilePath of unresolvedFilePaths) {
      const relativePath = fs.relativeTo(fs.cwd(), unresolvedFilePath);
      cli.log(
        `Error: ${relativePath} exists on disk but is not part of the project graph.`,
      );
      hasAnyProjectError = true;
    }
  } else {
    projectEntries = getEntriesFromCliOrConfig(args[0]);
  }

  if (projectEntries.length > 0) {
    logInfoForMissingSheriffConfig(projectEntries[0].projectInfo);
  }

  // Store validation results for each project
  const projectValidations = new Map<string, ProjectValidation>();

  for (const projectEntry of projectEntries) {
    // Initialize validation data for this project
    const validation: ProjectValidation = {
      deepImportsCount: 0,
      dependencyRulesCount: 0,
      externalRulesCount: 0,
      filesCount: 0,
      hasError: false,
      validationsMap: {},
      encapsulations: [],
      dependencyRuleViolations: [],
    };

    projectValidations.set(projectEntry.projectName, validation);
  }

  if (options.files) {
    for (const projectEntry of projectEntries) {
      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;
      const knownFilePaths = projectFilePaths.get(projectEntry.projectName)!;

      for (const fileInfoPath of knownFilePaths.values()) {
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
      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;

      for (const { fileInfo } of traverseFileInfo(
        projectEntry.projectInfo.fileInfo,
      )) {
        if (
          runChecksForFile(
            fileInfo.path,
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

function formatExternalRuleViolation(violation: ExternalRuleViolation): string {
  return `external library ${violation.externalLibrary} is not allowed for tag ${violation.fromTag}`;
}

function formatDependencyRuleViolation(
  violation: DependencyRuleViolation,
): string {
  if (violation.cause === 'deny-rule') {
    return `denyRules denied from tag ${violation.fromTag} to tags ${violation.toTags.join(', ')}`;
  }

  return `from tag ${violation.fromTag} to tags ${violation.toTags.join(', ')}`;
}
