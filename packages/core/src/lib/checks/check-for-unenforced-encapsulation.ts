import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { ProjectInfo } from '../main/init';
import { normalizePathSeparators } from '../modules/internal/segment-pattern';
import { traverseFileInfo } from '../modules/traverse-file-info';

/**
 * Why a folder matching the `encapsulationPattern` is not enforced:
 *
 * - `'module-has-barrel'`: the folder sits inside a module with a barrel
 *   file. The barrel alone controls what the module exposes, so the
 *   pattern folder is purely decorative.
 * - `'barrel-less-disabled'`: `enableBarrelLess` is `false`, so the
 *   encapsulation pattern is never evaluated anywhere in the project.
 */
export type UnenforcedEncapsulationReason =
  | 'module-has-barrel'
  | 'barrel-less-disabled';

/**
 * A folder whose name promises encapsulation (it matches the configured
 * `encapsulationPattern`) without Sheriff actually enforcing it.
 */
export type UnenforcedEncapsulation = {
  /** Absolute path of the folder matching the encapsulation pattern. */
  folderPath: FsPath;
  /** Absolute path of the module containing the folder. */
  modulePath: FsPath;
  /** Why the folder is not enforced. */
  reason: UnenforcedEncapsulationReason;
};

/**
 * Returns all folders matching the string `encapsulationPattern` whose
 * encapsulation promise is **not** enforced.
 *
 * The folder name (e.g. `internal/`) is a security promise to the reader.
 * It is only kept in barrel-less mode for modules without a barrel file:
 * inside a barrel module the barrel alone controls exposure, and with
 * `enableBarrelLess: false` the pattern is never evaluated at all. In both
 * cases the folder is decorative — exactly the class of silent
 * configuration gaps `sheriff doctor` reports.
 *
 * A `RegExp` pattern matches arbitrary relative paths and cannot be
 * attributed to a single folder, so the scan only runs for string patterns.
 */
export function checkForUnenforcedEncapsulation(
  projectInfo: ProjectInfo,
): UnenforcedEncapsulation[] {
  const { config } = projectInfo;
  const pattern = config.encapsulationPattern;
  if (typeof pattern !== 'string') {
    return [];
  }

  const fs = getFs();
  const seenFolders = new Set<string>();
  const findings: UnenforcedEncapsulation[] = [];

  for (const { fileInfo } of traverseFileInfo(projectInfo.fileInfo)) {
    const module = fileInfo.moduleInfo;
    const relativePath = normalizePathSeparators(
      fs.relativeTo(module.path, fileInfo.path),
    );
    const segments = relativePath.split('/');
    // the file name itself never counts as a pattern folder
    segments.pop();

    // Mirror the enforcement semantics: at the module root the pattern is
    // a prefix (`relativePath.startsWith(pattern)`), deeper down only an
    // exact segment counts as a pattern folder.
    const matchIndex = segments.findIndex((segment, index) =>
      index === 0 ? segment.startsWith(pattern) : segment === pattern,
    );
    if (matchIndex === -1) {
      continue;
    }

    let reason: UnenforcedEncapsulationReason;
    if (!config.enableBarrelLess) {
      reason = 'barrel-less-disabled';
    } else if (module.kind === 'barrel') {
      reason = 'module-has-barrel';
    } else if (matchIndex > 0) {
      // Nested pattern folders in barrel-less modules without a barrel are
      // intentionally NOT reported here: string encapsulation patterns
      // match at any depth (issue #31, task 1 — see
      // `isEncapsulatedByStringPattern`), so these folders ARE enforced.
      // Reporting them as unenforced would contradict that enforcement;
      // this check only flags the barrel-module and barrel-less-off cases.
      continue;
    } else {
      // top-level pattern folder in a barrel-less module: enforced
      continue;
    }

    const folderPath = toFsPath(
      fs.join(module.path, segments.slice(0, matchIndex + 1).join('/')),
    );
    if (seenFolders.has(folderPath)) {
      continue;
    }
    seenFolders.add(folderPath);

    findings.push({ folderPath, modulePath: module.path, reason });
  }

  return findings;
}
