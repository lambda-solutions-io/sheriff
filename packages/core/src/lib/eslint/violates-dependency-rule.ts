import { FsPath } from '../file-info/fs-path';
import { logger } from '../log';
import { DependencyRuleViolation } from '../checks/check-for-dependency-rule-violation';
import { ExternalRuleViolation } from '../checks/check-for-external-rule-violation';
import { getDocumentLintAnalysis } from './lint-document';

const log = logger('core.eslint.dependency-rules');

export const violatesDependencyRule = (
  filename: string,
  importCommand: string,
  isFirstRun: boolean,
  fileContent: string,
): string => {
  const {
    rootDir,
    configFileIsMissing,
    getDependencyRuleViolation,
    getExternalRuleViolation,
    isUnresolvableImport,
  } = getDocumentLintAnalysis(filename, fileContent, true);
  if (configFileIsMissing) {
    if (isFirstRun) {
      log.info('no sheriff.config.ts present');
    }
    return '';
  }
  if (!rootDir) {
    throw new Error('document lint analysis is missing its root directory');
  }

  if (isUnresolvableImport(importCommand)) {
    return `import ${importCommand} cannot be resolved`;
  }

  const dependencyRuleViolation = getDependencyRuleViolation(importCommand);
  if (dependencyRuleViolation) {
    return formatViolation(dependencyRuleViolation, rootDir);
  }
  const externalRuleViolation = getExternalRuleViolation(importCommand);
  if (externalRuleViolation) {
    return formatExternalViolation(externalRuleViolation, rootDir);
  }

  return '';
};

function formatViolation(
  violation: DependencyRuleViolation,
  rootDir: FsPath,
): string {
  const { fromModulePath, toModulePath } = violation;
  const prefix = `module ${fromModulePath.substring(
    rootDir.length,
  )} cannot access ${toModulePath.substring(rootDir.length)}.`;

  if (violation.cause === 'deny-rule') {
    return `${prefix} Tag ${violation.fromTag} is denied by denyRules for tags ${violation.toTags.join(', ')}`;
  }

  return `${prefix} Tag ${violation.fromTag} has no clearance for tags ${violation.toTags.join(', ')}`;
}

function formatExternalViolation(
  violation: ExternalRuleViolation,
  rootDir: FsPath,
): string {
  const fromModulePath = violation.fromModulePath.substring(rootDir.length);
  return `module ${fromModulePath} cannot import external library ${violation.externalLibrary}. Tag ${violation.fromTag} has no clearance in externalRules`;
}
