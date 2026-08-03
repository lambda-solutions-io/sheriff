import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { ProjectInfo } from '../main/init';
import { findBarrelDirectories } from '../modules/find-module-paths';
import {
  matchesFolderPathGlob,
  normalizePathSeparators,
} from '../modules/internal/segment-pattern';

/**
 * A barrel file which the configured `barrelPolicy` does not permit.
 */
export type BarrelPolicyViolation = {
  /**
   * Absolute path of the directory owning the barrel file — the module path,
   * except with `moduleIdentity: 'config'`, where a barrel file outside every
   * configured module creates no module and the directory is reported
   * instead. It is what `allowBarrelsIn` is matched against either way.
   */
  modulePath: FsPath;
  /** Absolute path of the barrel file. */
  barrelFilePath: FsPath;
  /** Human-readable violation message stating the consequence. */
  message: string;
};

/**
 * Every barrel file the policy has an opinion about, before `allowBarrelsIn`
 * is applied. Under `moduleIdentity: 'auto'` this is exactly the set of
 * barrel modules plus a root-level barrel (see {@link findRootBarrel});
 * under `'config'` it additionally contains barrel files in directories
 * which are not modules (see {@link findBarrelsOutsideModules}).
 */
export function findBarrelCandidates(
  projectInfo: ProjectInfo,
): BarrelPolicyViolation[] {
  const { config, modules } = projectInfo;

  const barrelModules = modules
    // `kind` is the metadata view a diagnostic may read; `hasBarrel` is
    // private so no consumer can branch on it for an access decision.
    .filter((module) => module.kind === 'barrel')
    .map((module) => ({
      modulePath: module.path,
      barrelFilePath: module.barrelPath,
      message: `${config.barrelFileName} turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to \`allowBarrelsIn\`.`,
    }));

  return [
    ...barrelModules,
    ...findBarrelsOutsideModules(projectInfo),
    ...findRootBarrel(projectInfo),
  ];
}

/**
 * A barrel file in the project root.
 *
 * The root module is always created barrel-less (`createModules` overwrites
 * whatever the module scan detected for the root directory), so a root-level
 * barrel file never turns it into a barrel module. That makes it invisible
 * to both the module-driven scan (`kind` stays `'barrel-less'`) and — under
 * `moduleIdentity: 'config'` — to {@link findBarrelsOutsideModules}, whose
 * not-a-module filter drops the root directory (issue #48). It is therefore
 * probed directly on the filesystem. In `allowBarrelsIn` the root is
 * addressable as `.`.
 */
function findRootBarrel({
  config,
  modules,
}: ProjectInfo): BarrelPolicyViolation[] {
  const fs = getFs();
  const rootModule = modules.find((module) => module.isRoot);
  if (!rootModule) {
    return [];
  }

  // `Module.barrelPath` requires the file to exist, so probe the raw path
  const rootBarrelPath = fs.join(rootModule.path, config.barrelFileName);
  if (!fs.exists(rootBarrelPath)) {
    return [];
  }

  return [
    {
      modulePath: rootModule.path,
      barrelFilePath: toFsPath(rootBarrelPath),
      message: `${config.barrelFileName} sits in the project root. The root module is always barrel-less, so the file has no effect on encapsulation. Remove it or add \`.\` to \`allowBarrelsIn\`.`,
    },
  ];
}

/**
 * Barrel files which do not belong to any module.
 *
 * With `moduleIdentity: 'config'` a barrel file no longer creates a module,
 * so a stray `index.ts` in a directory that no `modules` pattern covers is
 * invisible to a module-driven scan — the exact case
 * `moduleIdentity: 'config'` is meant to defuse would become undiagnosable.
 * They are therefore enumerated straight from the filesystem.
 *
 * With `moduleIdentity: 'auto'` every barrel file owns a module, so this is
 * empty by construction and skipped.
 */
function findBarrelsOutsideModules({
  config,
  modules,
  projectDirs,
}: ProjectInfo): BarrelPolicyViolation[] {
  if (config.moduleIdentity !== 'config') {
    return [];
  }

  const fs = getFs();
  const modulePaths = new Set(modules.map((module) => module.path));

  return findBarrelDirectories(projectDirs, config.barrelFileName)
    .filter((directory) => !modulePaths.has(directory))
    .map((directory) => ({
      modulePath: directory,
      barrelFilePath: toFsPath(fs.join(directory, config.barrelFileName)),
      message: `${config.barrelFileName} sits outside any module configured via \`modules\`. With moduleIdentity: 'config' it creates no module and has no effect on encapsulation. Remove it, add its directory to \`modules\`, or add it to \`allowBarrelsIn\`.`,
    }));
}

/**
 * Returns all barrel files which violate the configured `barrelPolicy`.
 *
 * In barrel-less mode (`enableBarrelLess: true`) the absence of a barrel
 * file is load-bearing configuration: a stray `index.ts` silently turns a
 * barrel-less module into a barrel module and changes its encapsulation
 * semantics. With `barrelPolicy` set to `'warn'` or `'forbid'`, every module
 * with a barrel file is reported unless its module path (relative to the
 * project root) matches one of the `allowBarrelsIn` globs.
 *
 * With `moduleIdentity: 'config'` a barrel file creates no module, so
 * barrels outside every configured module are reported too — otherwise
 * turning the flag on would trade one silent failure for another. They obey
 * `allowBarrelsIn` in the same way, matched against their directory.
 *
 * A barrel file in the project root is reported as well: the root module is
 * always barrel-less, so the file is inert under every module identity (see
 * {@link findRootBarrel}). In `allowBarrelsIn` it matches the pattern `.`.
 *
 * With `barrelPolicy: 'allow'` (default) or without barrel-less mode, no
 * violations are reported. It is up to the caller to decide whether a
 * violation fails the run (`'forbid'`) or is only reported (`'warn'`).
 */
export function checkForBarrelPolicyViolation(
  projectInfo: ProjectInfo,
): BarrelPolicyViolation[] {
  const { config, rootDir } = projectInfo;
  if (!config.enableBarrelLess || config.barrelPolicy === 'allow') {
    return [];
  }

  const fs = getFs();

  return findBarrelCandidates(projectInfo).filter((candidate) => {
    const relativeModulePath =
      normalizePathSeparators(fs.relativeTo(rootDir, candidate.modulePath)) ||
      // the root barrel's directory is the root itself; give it an
      // addressable name instead of the empty string.
      '.';

    return !config.allowBarrelsIn.some((pattern) =>
      matchesFolderPathGlob(pattern, relativeModulePath),
    );
  });
}
