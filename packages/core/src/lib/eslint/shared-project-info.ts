import { createHash } from 'node:crypto';
import { FsPath } from '../file-info/fs-path';
import { ProjectInfo } from '../main/init';

/**
 * ESLint instantiates every Sheriff rule separately and calls it once per
 * import node. Each rule therefore used to run its own `init()` for the very
 * same file, re-doing the expensive part (tsconfig parsing, module discovery,
 * `createModules`) once per (file, rule) pair.
 *
 * This cache shares one `init()` result between all rules looking at the same
 * file, so the cost is paid once per file instead of once per file and rule.
 *
 * Why a dedicated cache instead of `project-cache.ts`: the entry depends on
 * `fileContent`, which for ESLint is the *editor buffer*, not the file on
 * disk. That content cannot be expressed as an mtime dependency stamp, so it
 * goes into the key instead. Everything `init()` reads from disk is already
 * cached (and invalidated) one layer down by `project-cache.ts`.
 *
 * Only the most recent file is retained: ESLint processes files one at a time
 * and finishes all rules for a file before moving on, so a single slot gives
 * the full cross-rule hit rate without unbounded retention of `ProjectInfo`
 * graphs.
 */

type SharedEntry = {
  key: string;
  projectInfo: ProjectInfo;
};

let entry: SharedEntry | undefined;

/**
 * Hashed so the key stays small regardless of file size; a collision would
 * require two different buffers of the same file to hash identically.
 */
function buildKey(filename: string, fileContent: string): string {
  return `${filename}\0${createHash('sha1').update(fileContent).digest('hex')}`;
}

/**
 * Returns the `init()` result for this (file, content) pair, computing it only
 * if the previous caller asked for a different one.
 */
export function getSharedProjectInfo(
  fsPath: FsPath,
  fileContent: string,
  compute: () => ProjectInfo,
): ProjectInfo {
  const key = buildKey(fsPath, fileContent);
  if (entry?.key === key) {
    return entry.projectInfo;
  }

  const projectInfo = compute();
  entry = { key, projectInfo };
  return projectInfo;
}

/**
 * Same as `getSharedProjectInfo`, but for callers that tolerate a missing
 * config and therefore may legitimately compute `undefined`. A missing config
 * is not cached: it is cheap to re-derive and caching it would need a second
 * sentinel state.
 */
export function getSharedProjectInfoOrUndefined(
  fsPath: FsPath,
  fileContent: string,
  compute: () => ProjectInfo | undefined,
): ProjectInfo | undefined {
  const key = buildKey(fsPath, fileContent);
  if (entry?.key === key) {
    return entry.projectInfo;
  }

  const projectInfo = compute();
  if (projectInfo) {
    entry = { key, projectInfo };
  }
  return projectInfo;
}

/** Test-only: drops the retained entry so specs do not leak into each other. */
export function clearSharedProjectInfo(): void {
  entry = undefined;
}
