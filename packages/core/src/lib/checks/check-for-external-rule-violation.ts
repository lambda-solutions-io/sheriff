import { ExternalRulesConfig } from '../config/dependency-rules-config';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { ProjectInfo } from '../main/init';
import { calcTagsForModule } from '../tags/calc-tags-for-module';
import { wildcardToRegex } from '../util/wildcard-to-regex';

/**
 * A violation of an `externalRules` entry, i.e. an import from `node_modules`
 * which the importing module's tags do not permit.
 */
export type ExternalRuleViolation = {
  externalLibrary: string;
  fromModulePath: FsPath;
  fromFilePath: FsPath;
  fromTag: string;
};

/**
 * Verifies the file's imports from `node_modules` against `externalRules`.
 */
export function checkForExternalRuleViolation(
  fsPath: FsPath,
  { config, getFileInfo, rootDir }: ProjectInfo,
): ExternalRuleViolation[] {
  if (Object.keys(config.externalRules).length === 0) {
    return [];
  }

  const assignedFileInfo = getFileInfo(fsPath);
  const fromModulePath = toFsPath(assignedFileInfo.moduleInfo.path);
  const fromTags = calcTagsForModule(
    fromModulePath,
    rootDir,
    config.modules,
    config.autoTagging,
  );
  const violations: ExternalRuleViolation[] = [];

  for (const externalLibrary of assignedFileInfo.getExternalLibraries()) {
    for (const fromTag of fromTags) {
      if (
        isExternalLibraryAllowed(
          fromTag,
          externalLibrary,
          config.externalRules,
          {
            fromTags,
            fromModulePath,
            fromFilePath: fsPath,
          },
        )
      ) {
        continue;
      }

      violations.push({
        externalLibrary,
        fromModulePath,
        fromFilePath: fsPath,
        fromTag,
      });
      break;
    }
  }

  return violations;
}

function isExternalLibraryAllowed(
  from: string,
  externalLibrary: string,
  config: ExternalRulesConfig,
  context: Pick<ExternalRuleViolation, 'fromModulePath' | 'fromFilePath'> & {
    fromTags: string[];
  },
): boolean {
  for (const tagPattern in config) {
    if (!from.match(wildcardToRegex(tagPattern))) {
      continue;
    }

    const rule = config[tagPattern];
    const isAllowed =
      typeof rule === 'function'
        ? rule({ ...context, from, externalLibrary })
        : rule.some((libraryPattern) =>
            externalLibrary.match(wildcardToRegex(libraryPattern)),
          );

    if (!isAllowed) {
      return false;
    }
  }

  return true;
}
