import { FsPath } from '../file-info/fs-path';
import { findModulePathsWithBarrel } from './internal/find-module-paths-with-barrel';
import { findModulePathsWithoutBarrel } from './internal/find-module-paths-without-barrel';
import { Configuration } from '../config/configuration';
import { isModuleDefinition, ModuleConfig } from '../config/module-config';
import getFs from '../fs/getFs';
import { PLACE_HOLDER_REGEX } from '../tags/calc-tags-for-module';
import { wildcardToRegex } from '../util/wildcard-to-regex';

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
  const modulesWithoutBarrel = enableBarrelLess
    ? findModulePathsWithoutBarrel(modules, rootDir, barrelFileName)
    : [];
  const modulesWithBarrel = findModulePathsWithBarrel(
    projectDirs,
    barrelFileName,
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

function findExportsForModulePath(
  modulePath: FsPath,
  rootDir: FsPath,
  moduleConfig: ModuleConfig,
): string[] | undefined {
  const fs = getFs();
  const relativeModulePath = fs.relativeTo(rootDir, modulePath);

  return flattenModuleExports(moduleConfig)
    .filter(({ path }) => wildcardToRegex(path).test(relativeModulePath))
    .sort((left, right) => right.path.length - left.path.length)
    .at(0)?.exports;
}

function flattenModuleExports(
  moduleConfig: ModuleConfig,
  prefix = '',
): { path: string; exports: string[] }[] {
  let flattened: { path: string; exports: string[] }[] = [];

  for (const [rawPath, value] of Object.entries(moduleConfig)) {
    const path = rawPath.replace(PLACE_HOLDER_REGEX, '*');
    const fullPath = prefix ? `${prefix}/${path}` : path;

    if (isModuleDefinition(value)) {
      if (value.exports !== undefined) {
        flattened.push({ path: fullPath, exports: value.exports });
      }
    } else if (
      typeof value !== 'string' &&
      typeof value !== 'function' &&
      !Array.isArray(value)
    ) {
      flattened = [...flattened, ...flattenModuleExports(value, fullPath)];
    }
  }

  return flattened;
}
