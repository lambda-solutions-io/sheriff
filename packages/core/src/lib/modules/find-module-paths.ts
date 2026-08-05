import { FsPath } from '../file-info/fs-path';
import { findModulePathsWithBarrel } from './internal/find-module-paths-with-barrel';
import {
  ConfiguredModulePaths,
  findModulePathsWithoutBarrel,
} from './internal/find-module-paths-without-barrel';
import { Configuration } from '../config/configuration';
import { isModuleDefinition, ModuleConfig } from '../config/module-config';
import getFs from '../fs/getFs';
import { PLACE_HOLDER_REGEX } from '../tags/calc-tags-for-module';
import {
  hasSourceFileExtension,
  matchesFolderPathGlob,
  normalizePathSeparators,
} from './internal/segment-pattern';
import { flattenModules } from './internal/flatten-modules';
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

  /**
   * Whether the module is a single file instead of a directory. A file
   * module always exposes exactly its own file.
   */
  isFileModule?: boolean;
}

export type ModulePathMap = Record<FsPath, boolean | ModulePathInfo>;

/**
 * Find module paths which can be defined via having a barrel file or the
 * configuration's property `modules`.
 *
 * If a module has a barrel file and an internal, it is of type barrel file.
 *
 * With `moduleIdentity: 'config'` a barrel file never creates a module:
 * only the `modules` configuration does. A configured module which happens
 * to contain the barrel file keeps its identity (and its configured tags),
 * but is a barrel module for exposure purposes. Its configured `exports`
 * are preserved on the entry, even though `Module.exposes` lets the barrel
 * win over them — the barrel alone decides exposure, exactly like in
 * `'auto'` mode.
 */
export function findModulePaths(
  projectDirs: FsPath[],
  rootDir: FsPath,
  sheriffConfig: Configuration,
): ModulePathMap {
  const { modules, enableBarrelLess, barrelFileName, moduleIdentity } =
    sheriffConfig;
  const identityFromConfigOnly = moduleIdentity === 'config';

  // outside barrel-less mode the config walk only serves file-module keys.
  // Without such keys it is skipped entirely, so existing barrel projects
  // keep their exact behavior and pay no extra filesystem scan - but a
  // configured file module must not stay silently dead there (fail-open).
  const useConfiguredModulePaths =
    enableBarrelLess || hasFileModuleKeys(modules);

  // both finders walk the filesystem for every `init()`. Their results
  // depend on directory structure, which mtime stamps cannot validate,
  // so they are cached with a staleness window (see project-cache).
  const modulesFromConfig: ConfiguredModulePaths = useConfiguredModulePaths
    ? getOrCompute(
        `module-paths-without-barrel\0${rootDir}\0${barrelFileName}\0${identityFromConfigOnly}\0${stringifyModulesForCacheKey(modules)}`,
        () => ({
          value: findModulePathsWithoutBarrel(
            modules,
            rootDir,
            barrelFileName,
            identityFromConfigOnly,
          ),
          dependencies: [],
        }),
        { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
      )
    : { directories: new Set<FsPath>(), files: new Set<FsPath>() };

  const fileModulePaths: ModulePathMap = {};
  for (const path of modulesFromConfig.files) {
    fileModulePaths[path] = { hasBarrel: false, isFileModule: true };
  }

  const modulePaths: ModulePathMap = { ...fileModulePaths };

  if (identityFromConfigOnly) {
    const fs = getFs();
    for (const path of modulesFromConfig.directories) {
      modulePaths[path] = {
        // exact-case probe: must agree with the case-sensitive barrel
        // path comparison in `Module.exposes` (issue #70)
        hasBarrel: fs.existsCaseSensitive(fs.join(path, barrelFileName)),
        exports: findExportsForModulePath(path, rootDir, modules),
      };
    }

    return modulePaths;
  }

  // configured directories only become modules in barrel-less mode;
  // file modules (already merged above) work in both modes
  if (enableBarrelLess) {
    for (const path of modulesFromConfig.directories) {
      modulePaths[path] = {
        hasBarrel: false,
        exports: findExportsForModulePath(path, rootDir, modules),
      };
    }
  }

  const modulesWithBarrel = findBarrelDirectories(projectDirs, barrelFileName);
  for (const path of modulesWithBarrel) {
    modulePaths[path] = { hasBarrel: true };
  }

  return modulePaths;
}

/**
 * Whether any module key defines single-file modules, i.e. its last
 * segment literally ends with a source-file extension.
 */
function hasFileModuleKeys(modules: ModuleConfig): boolean {
  return flattenModules(modules, '').some((pattern) => {
    const segments = pattern.split('/');
    return hasSourceFileExtension(segments[segments.length - 1]);
  });
}

/**
 * All directories below `projectDirs` which contain the barrel file,
 * independent of module identity.
 *
 * Cached like the other structure walks, so callers outside module creation
 * (the barrel policy check under `moduleIdentity: 'config'`) reuse the same
 * filesystem scan instead of doing a second one.
 */
export function findBarrelDirectories(
  projectDirs: FsPath[],
  barrelFileName: string,
): FsPath[] {
  return getOrCompute(
    `module-paths-with-barrel\0${barrelFileName}\0${[...projectDirs].sort().join(',')}`,
    () => ({
      value: findModulePathsWithBarrel(projectDirs, barrelFileName),
      dependencies: [],
    }),
    { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
  );
}

/**
 * `JSON.stringify` drops function-valued properties (tag matcher functions,
 * also inside nested sub-configs), so two different module configs could
 * collide on the same cache key and the second one would silently reuse the
 * first one's module paths (issue #45). A function leaf only marks its key
 * as a leaf module — the resulting paths never depend on the function body —
 * so replacing every function with a fixed marker keeps the key both stable
 * and collision-free.
 */
function stringifyModulesForCacheKey(modules: ModuleConfig): string {
  return JSON.stringify(modules, (_key, value: unknown) =>
    typeof value === 'function' ? '[function]' : value,
  );
}

function findExportsForModulePath(
  modulePath: FsPath,
  rootDir: FsPath,
  moduleConfig: ModuleConfig,
): string[] | undefined {
  const fs = getFs();
  const relativeModulePath = normalizePathSeparators(
    fs.relativeTo(rootDir, modulePath),
  );

  return flattenModuleEntries(moduleConfig)
    .filter(({ path }) => matchesFolderPathGlob(path, relativeModulePath))
    .sort((left, right) => getSpecificity(right) - getSpecificity(left))
    .at(0)?.exports;
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
  // a `**` spans arbitrarily many segments, so any pattern without one is
  // more specific than any pattern with one, regardless of segment count
  const recursiveGlobs = segments.filter(
    (segment) => segment === '**',
  ).length;
  return (
    recursiveGlobs * -100_000 + segments.length * 100 + staticSegments.length
  );
}
