import { ProjectData, getProjectData as getProjectDataFn } from '../api/get-project-data';
import { checkForDependencyRuleViolation } from '../checks/check-for-dependency-rule-violation';
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
): EntryWithProjectInfo[] {
  return getEntriesFromCliOrConfig(entryFile, true, config);
}

function getEntriesWithoutInit(
  config: Configuration,
  entryFile?: string,
): Entry[] {
  return getEntriesFromCliOrConfig(entryFile, false, config);
}

function verifyForPlugin(
  config: Configuration,
  entryFile?: string,
): VerificationResult {
  const fs = getFs();
  const projectEntries = getEntries(config, entryFile);
  let encapsulationViolationCount = 0;
  let dependencyRuleViolationCount = 0;
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

      if (
        encapsulationViolations.length === 0 &&
        dependencyRuleViolations.length === 0
      ) {
        continue;
      }

      filesWithViolationsCount++;
      encapsulationViolationCount += encapsulationViolations.length;
      dependencyRuleViolationCount += dependencyRuleViolations.length;

      const relativePath = fs.relativeTo(fs.cwd(), fileInfo.path);
      const dependencyViolations: DependencyViolationInfo[] =
        dependencyRuleViolations.map((violation) => ({
          fromTag: violation.fromTag,
          toTags: violation.toTags,
          rawImport: violation.rawImport,
        }));

      violations[relativePath] = {
        encapsulationViolations,
        dependencyRuleViolations: dependencyViolations,
      };
    }
  }

  return {
    success:
      encapsulationViolationCount === 0 && dependencyRuleViolationCount === 0,
    encapsulationViolationCount,
    dependencyRuleViolationCount,
    filesWithViolationsCount,
    violations,
  };
}

function getProjectDataForPlugin(
  config: Configuration,
  entryFile?: string,
  options?: ProjectDataOptions,
): ProjectData {
  const fs = getFs();
  const projectEntries = getEntriesWithoutInit(config, entryFile);
  const entry = projectEntries[0];
  const absoluteEntryFile = fs.join(fs.cwd(), entry.entryFile);

  return getProjectDataFn(absoluteEntryFile, {
    projectName: entry.projectName,
    ...options,
  });
}

export function createPluginAPI(config: Configuration): SheriffPluginAPI {
  return {
    verify: (entryFile?: string) => verifyForPlugin(config, entryFile),
    getProjectData: (entryFile?: string, options?: ProjectDataOptions) =>
      getProjectDataForPlugin(config, entryFile, options),
    getConfig: () => config,
    log: (message: string) => cli.log(message),
    logError: (message: string) => cli.logError(message),
  };
}
