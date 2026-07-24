import { toFsPath } from '../file-info/fs-path';
import { getDocumentLintAnalysis } from './lint-document';

/**
 * This is the adapter for the ESLint plugin's `barrel-policy` rule.
 *
 * It reports on the barrel file itself: if the linted file is the barrel
 * file of a module which violates `barrelPolicy: 'forbid'` (barrel-less
 * mode and not excluded via `allowBarrelsIn`), the violation message is
 * returned. For any other file, or with `barrelPolicy` set to `'allow'` or
 * `'warn'`, an empty string is returned — `'warn'` is an observation phase
 * surfaced by `sheriff verify` only and never turns into ESLint reports.
 *
 * @param filename Name of the linted file
 * @param fileContent Content of the linted file
 */
export const violatesBarrelPolicy = (
  filename: string,
  fileContent: string,
): string => {
  const analysis = getDocumentLintAnalysis(filename, fileContent, true);
  if (analysis.configFileIsMissing) {
    return '';
  }

  const lintedFilePath = toFsPath(filename);
  const violation = analysis.result.barrelPolicyViolations.find(
    (barrelPolicyViolation) =>
      barrelPolicyViolation.barrelFilePath === lintedFilePath,
  );

  return violation ? violation.message : '';
};
