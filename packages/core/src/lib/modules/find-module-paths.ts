import { FsPath } from '../file-info/fs-path';
import { findModulePathsWithBarrel } from './internal/find-module-paths-with-barrel';
import { findModulePathsWithoutBarrel } from './internal/find-module-paths-without-barrel';
import { Configuration } from '../config/configuration';
import { isModuleDefinition, ModuleConfig } from '../config/module-config';
import getFs from '../fs/getFs';
import { PLACE_HOLDER_REGEX } from '../tags/calc-tags-for-module';
import {
  matchesFolderPathPattern,
  normalizePathSeparators,
} from './internal/segment-pattern';
import {
  DEFAULT_STRUCTURE_CACHE_TTL_MS,
  getOrCompute,
} from '../cache/project-cache';

export interface ModulePathInfo {
  /**
   * Whether this module is exposed through a barrel file.
   */
  hasBarrel: boolean;

  /**
   * Module-relative file patterns that can be imported from outside.
   */
  exports?: string[];
}

export type ModulePathMap = Record<FsPath, boolean | ModulePathInfo>;

/**
 * Find module paths which can be defined via having a barrel file or the
 * configuration's property `modules`.
 *
 * If a module has a barrel file and an internal, it is of type barrel file.
 */
export function findModulePaths(
  projectDirs: FsPath[],
  rootDir: FsPath,
  sheriffConfig: Configuration,
): ModulePathMap {
  const { modules, enableBarrelLess, barrelFileName } = sheriffConfig;

  // both finders walk the filesystem for every `init()`. Their results
  // depend on directory structure, which mtime stamps cannot validate,
  // so they are cached with a staleness window (see project-cache).
  const modulesWithoutBarrel = enableBarrelLess
    ? getOrCompute(
        `module-paths-without-barrel\0${rootDir}\0${barrelFileName}\0${JSON.stringify(modules)}`,
        () => ({
          value: findModulePathsWithoutBarrel(modules, rootDir, barrelFileName),
          dependencies: [],
        }),
        { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
      )
    : [];
  const modulesWithBarrel = getOrCompute(
    `module-paths-with-barrel\0${barrelFileName}\0${[...projectDirs].sort().join(',')}`,
    () => ({
      value: findModulePathsWithBarrel(projectDirs, barrelFileName),
      dependencies: [],
    }),
    { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
  );
  const modulePaths: ModulePathMap = {};

  for (const path of modulesWithoutBarrel) {
    modulePaths[path] = {
      hasBarrel: false,
      exports: findExportsForModulePath(path, rootDir, modules),
    };
  }

  for (const path of modulesWithBarrel) {
    modulePaths[path] = { hasBarrel: true };
  }

  return modulePaths;
}

type PreparedModuleEntry = { path: string; exports?: string[] };

/**
 * The flattened, specificity-sorted config is identical for every module in
 * a project, so it is prepared once per config object instead of once per
 * module (which made barrel-less `init()` cost O(modules x configEntries)).
 * Keyed by config identity, so a reparsed config produces a fresh entry.
 */
const preparedEntriesByModuleConfig = new WeakMap<
  ModuleConfig,
  PreparedModuleEntry[]
>();

function findExportsForModulePath(
  modulePath: FsPath,
  rootDir: FsPath,
  moduleConfig: ModuleConfig,
): string[] | undefined {
  const fs = getFs();
  const relativeModulePath = normalizePathSeparators(
    fs.relativeTo(rootDir, modulePath),
  );

  // The list is pre-sorted by descending specificity, so the first match is
  // the winner. `sort` is stable, so equally specific entries keep their
  // declaration order — same tie-break as the previous filter/sort/at(0).
  return getPreparedModuleEntries(moduleConfig).find(({ path }) =>
    matchesFolderPathPattern(path, relativeModulePath),
  )?.exports;
}

function getPreparedModuleEntries(
  moduleConfig: ModuleConfig,
): PreparedModuleEntry[] {
  const cachedEntries = preparedEntriesByModuleConfig.get(moduleConfig);
  if (cachedEntries) {
    return cachedEntries;
  }

  const entries = flattenModuleEntries(moduleConfig).sort(
    (left, right) => getSpecificity(right) - getSpecificity(left),
  );
  preparedEntriesByModuleConfig.set(moduleConfig, entries);
  return entries;
}

function flattenModuleEntries(
  moduleConfig: ModuleConfig,
  prefix = '',
): { path: string; exports?: string[] }[] {
  let flattened: { path: string; exports?: string[] }[] = [];

  for (const [rawPath, value] of Object.entries(moduleConfig)) {
    const path = rawPath.replace(PLACE_HOLDER_REGEX, '*');
    const fullPath = prefix ? `${prefix}/${path}` : path;

    if (isModuleDefinition(value)) {
      flattened.push({ path: fullPath, exports: value.exports });
    } else if (
      typeof value !== 'string' &&
      typeof value !== 'function' &&
      !Array.isArray(value)
    ) {
      flattened = [...flattened, ...flattenModuleEntries(value, fullPath)];
    } else {
      flattened.push({ path: fullPath });
    }
  }

  return flattened;
}

function getSpecificity(moduleExport: { path: string }): number {
  const segments = normalizePathSeparators(moduleExport.path).split('/');
  const staticSegments = segments.filter((segment) => !segment.includes('*'));
  return segments.length * 100 + staticSegments.length;
}
