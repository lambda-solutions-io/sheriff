import { FsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { ProjectInfo } from '../main/init';
import {
  matchesFolderPathGlob,
  normalizePathSeparators,
} from '../modules/internal/segment-pattern';

/**
 * A barrel module which the configured `barrelPolicy` does not permit.
 */
export type BarrelPolicyViolation = {
  /** Absolute path of the barrel module. */
  modulePath: FsPath;
  /** Absolute path of the module's barrel file. */
  barrelFilePath: FsPath;
  /** Human-readable violation message stating the consequence. */
  message: string;
};

/**
 * Returns all barrel modules which violate the configured `barrelPolicy`.
 *
 * In barrel-less mode (`enableBarrelLess: true`) the absence of a barrel
 * file is load-bearing configuration: a stray `index.ts` silently turns a
 * barrel-less module into a barrel module and changes its encapsulation
 * semantics. With `barrelPolicy` set to `'warn'` or `'forbid'`, every module
 * with a barrel file is reported unless its module path (relative to the
 * project root) matches one of the `allowBarrelsIn` globs.
 *
 * With `barrelPolicy: 'allow'` (default) or without barrel-less mode, no
 * violations are reported. It is up to the caller to decide whether a
 * violation fails the run (`'forbid'`) or is only reported (`'warn'`).
 */
export function checkForBarrelPolicyViolation({
  config,
  modules,
  rootDir,
}: ProjectInfo): BarrelPolicyViolation[] {
  if (!config.enableBarrelLess || config.barrelPolicy === 'allow') {
    return [];
  }

  const fs = getFs();
  const violations: BarrelPolicyViolation[] = [];

  for (const module of modules) {
    if (!module.hasBarrel) {
      continue;
    }

    const relativeModulePath = normalizePathSeparators(
      fs.relativeTo(rootDir, module.path),
    );

    if (
      config.allowBarrelsIn.some((pattern) =>
        matchesFolderPathGlob(pattern, relativeModulePath),
      )
    ) {
      continue;
    }

    violations.push({
      modulePath: module.path,
      barrelFilePath: module.barrelPath,
      message: `${config.barrelFileName} turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to \`allowBarrelsIn\`.`,
    });
  }

  return violations;
}
