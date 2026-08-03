import { FsPath, toFsPath } from '../file-info/fs-path';
import { ProjectInfo } from '../main/init';
import { calcTagsForModule } from '../tags/calc-tags-for-module';
import { isDependencyAllowed } from './is-dependency-allowed';
import { isDependencyDenied } from './is-dependency-denied';

/**
 * Describes why Sheriff reported a dependency rule violation.
 */
export type DependencyRuleViolationCause = 'deny-rule';

export type DependencyRuleViolation = {
  rawImport: string;
  fromModulePath: FsPath;
  toModulePath: FsPath;
  fromTag: string;
  toTags: string[];
  /**
   * Present when a dependency was allowed by `depRules` but then rejected by
   * `denyRules`. Missing means the importing tag had no depRules clearance.
   */
  cause?: DependencyRuleViolationCause;
};

export function checkForDependencyRuleViolation(
  fsPath: FsPath,
  { config, getFileInfo, rootDir }: ProjectInfo,
): DependencyRuleViolation[] {
  const violations: DependencyRuleViolation[] = [];

  if (config.isConfigFileMissing) {
    return [];
  }

  const assignedFileInfo = getFileInfo(fsPath);
  const importedFilePathsWithRawImport = assignedFileInfo.imports
    // skip imports of same module
    .filter(
      (importedFi) =>
        importedFi.moduleInfo.path !== assignedFileInfo.moduleInfo.path,
    )
    .map((fileInfo) => [
      fileInfo.moduleInfo.path,
      fileInfo.path,
      assignedFileInfo.getRawImportForImportedFileInfo(fileInfo.path),
    ]);
  const fromModule = toFsPath(assignedFileInfo.moduleInfo.path);
  const fromTags = calcTagsForModule(
    fromModule,
    rootDir,
    config.modules,
    config.autoTagging,
  );

  for (const [
    importedModulePath,
    importedFilePath,
    rawImport,
  ] of importedFilePathsWithRawImport) {
    for (const fromTag of fromTags) {
      const toTags: string[] = calcTagsForModule(
        toFsPath(importedModulePath),
        rootDir,
        config.modules,
        config.autoTagging,
      );
      const context = {
        fromModulePath: fromModule,
        toModulePath: toFsPath(importedModulePath),
        fromFilePath: fsPath,
        // the imported FILE, not its module directory (#47)
        toFilePath: toFsPath(importedFilePath),
        fromTags,
        toTags,
      };
      const isAllowed = isDependencyAllowed(
        fromTag,
        config.depRules,
        context,
      );

      if (!isAllowed) {
        violations.push({
          rawImport,
          fromModulePath: fromModule,
          toModulePath: toFsPath(importedModulePath),
          fromTag,
          toTags,
        });

        break;
      }

      if (isDependencyDenied(fromTag, config.denyRules, context)) {
        violations.push({
          rawImport,
          fromModulePath: fromModule,
          toModulePath: toFsPath(importedModulePath),
          fromTag,
          toTags,
          cause: 'deny-rule',
        });

        break;
      }
    }
  }

  return violations;
}
