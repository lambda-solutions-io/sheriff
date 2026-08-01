import { ProjectData, getProjectData as getProjectDataFn } from '../api/get-project-data';
import { checkForDependencyRuleViolation } from '../checks/check-for-dependency-rule-violation';
import { checkForExternalRuleViolation } from '../checks/check-for-external-rule-violation';
import { hasEncapsulationViolations } from '../checks/has-encapsulation-violations';
import { cli } from '../cli/cli';
import { Entry, EntryWithProjectInfo } from '../cli/internal/entry';
import { getEntriesFromCliOrConfig } from '../cli/internal/get-entries-from-cli-or-config';
import { Configuration } from '../config/configuration';
import getFs from '../fs/getFs';
import { traverseFileInfo } from '../modules/traverse-file-info';
import {
  DependencyViolationInfo,
  FileViolations,
  ProjectDataOptions,
  SheriffPluginAPI,
  VerificationResult,
} from './plugin-api';

function getEntries(
  config: Configuration,
  entryFile?: string,
  rootDir?: string,
): EntryWithProjectInfo[] {
  return getEntriesFromCliOrConfig(entryFile, true, config, rootDir);
}

function getEntriesWithoutInit(
  config: Configuration,
  entryFile?: string,
  rootDir?: string,
): Entry[] {
  return getEntriesFromCliOrConfig(entryFile, false, config, rootDir);
}

function verifyForPlugin(
  config: Configuration,
  entryFile?: string,
  rootDir?: string,
): VerificationResult {
  const fs = getFs();
  const root = rootDir ?? fs.cwd();
  const projectEntries = getEntries(config, entryFile, rootDir);
  let encapsulationViolationCount = 0;
  let dependencyRuleViolationCount = 0;
  let externalRuleViolationCount = 0;
  let filesWithViolationsCount = 0;
  const violations: Record<string, FileViolations> = {};

  for (const projectEntry of projectEntries) {
    for (const { fileInfo } of traverseFileInfo(
      projectEntry.projectInfo.fileInfo,
    )) {
      const encapsulationViolations = Object.keys(
        hasEncapsulationViolations(fileInfo.path, projectEntry.projectInfo),
      );
      const dependencyRuleViolations = checkForDependencyRuleViolation(
        fileInfo.path,
        projectEntry.projectInfo,
      );
      const externalRuleViolations = checkForExternalRuleViolation(
        fileInfo.path,
        projectEntry.projectInfo,
      );

      if (
        encapsulationViolations.length === 0 &&
        dependencyRuleViolations.length === 0 &&
        externalRuleViolations.length === 0
      ) {
        continue;
      }

      filesWithViolationsCount++;
      encapsulationViolationCount += encapsulationViolations.length;
      dependencyRuleViolationCount += dependencyRuleViolations.length;
      externalRuleViolationCount += externalRuleViolations.length;

      const relativePath = fs.relativeTo(root, fileInfo.path);
      const dependencyViolations: DependencyViolationInfo[] =
        dependencyRuleViolations.map((violation) => ({
          fromTag: violation.fromTag,
          toTags: violation.toTags,
          rawImport: violation.rawImport,
        }));

      violations[relativePath] = {
        encapsulationViolations,
        dependencyRuleViolations: dependencyViolations,
        externalRuleViolations: externalRuleViolations.map((violation) => ({
          fromTag: violation.fromTag,
          externalLibrary: violation.externalLibrary,
        })),
      };
    }
  }

  return {
    success:
      encapsulationViolationCount === 0 &&
      dependencyRuleViolationCount === 0 &&
      externalRuleViolationCount === 0,
    encapsulationViolationCount,
    dependencyRuleViolationCount,
    externalRuleViolationCount,
    filesWithViolationsCount,
    violations,
  };
}

function getProjectDataForPlugin(
  config: Configuration,
  entryFile?: string,
  options?: ProjectDataOptions,
  rootDir?: string,
): ProjectData {
  const fs = getFs();
  const projectEntries = getEntriesWithoutInit(config, entryFile, rootDir);
  const entry = projectEntries[0];
  const absoluteEntryFile = fs.join(rootDir ?? fs.cwd(), entry.entryFile);

  return getProjectDataFn(absoluteEntryFile, {
    projectName: entry.projectName,
    ...options,
  });
}

/** @param rootDir project root; defaults to the current working directory. */
export function createPluginAPI(
  config: Configuration,
  rootDir?: string,
): SheriffPluginAPI {
  return {
    verify: (entryFile?: string) => verifyForPlugin(config, entryFile, rootDir),
    getProjectData: (entryFile?: string, options?: ProjectDataOptions) =>
      getProjectDataForPlugin(config, entryFile, options, rootDir),
    // shallow copy so plugins cannot replace config fields seen by verify()
    getConfig: () => ({ ...config }),
    log: (message: string) => cli.log(message),
    logError: (message: string) => cli.logError(message),
  };
}
