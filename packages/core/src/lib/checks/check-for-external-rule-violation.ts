import { FsPath } from '../file-info/fs-path';
import { ProjectInfo } from '../main/init';

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
 *
 * TODO: not implemented yet — see task 2. This is a signature-only stub so
 * that the specs fail on their assertions instead of on a missing module.
 */
export function checkForExternalRuleViolation(
  _fsPath: FsPath,
  _projectInfo: ProjectInfo,
): ExternalRuleViolation[] {
  return [];
}
