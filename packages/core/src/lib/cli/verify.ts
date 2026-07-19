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
import { FsPath } from '../file-info/fs-path';
import { Fs } from '../fs/fs';

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
      new Set(options.files.map((file) => canonicalize(resolveFilePath(file, fs), fs))),
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
          cli.log(
            `Warning: ${relativePath} does not exist; skipping.`,
          );
        }
        return false;
      },
    );

    for (const projectEntry of projectEntries) {
      const projectValidation = projectValidations.get(
        projectEntry.projectName,
      )!;
      const knownFilePaths = projectFilePaths.get(projectEntry.projectName)!;

      for (const requestedFilePath of validRequestedFilePaths) {
        const fileInfoPath = knownFilePaths.get(requestedFilePath);
        if (
          fileInfoPath &&
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
  const externalRules = externalRuleViolations.map(
    formatExternalRuleViolation,
  );
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
