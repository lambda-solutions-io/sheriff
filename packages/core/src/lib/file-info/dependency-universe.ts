import { FsPath } from './fs-path';
import getFs from '../fs/getFs';
import {
  DEFAULT_STRUCTURE_CACHE_TTL_MS,
  getOrCompute,
} from '../cache/project-cache';

type DependencyManifest = {
  dependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
};

/**
 * Finds the nearest package manifest within `rootDir` and returns the package
 * names declared as runtime, peer, or optional dependencies.
 *
 * Results are cached in the project cache: the manifest *location* is
 * structure-dependent (a nearer package.json can appear) and therefore uses
 * the staleness window, the manifest *content* is validated via its mtime.
 *
 * @param fileDir directory of the importing file
 * @param rootDir upper inclusive boundary for the manifest search
 */
export function getDependencyUniverse(
  fileDir: FsPath,
  rootDir: FsPath,
): Set<string> {
  const fs = getFs();
  const relativeFileDir = normalizePath(fs.relativeTo(rootDir, fileDir));

  if (isOutsideRoot(relativeFileDir, fs.isAbsolute(relativeFileDir))) {
    return new Set<string>();
  }

  const manifestPath = getOrCompute(
    `dependency-manifest\0${normalizePath(rootDir)}\0${normalizePath(fileDir)}`,
    () => ({
      value: findNearestManifest(fileDir, rootDir),
      dependencies: [],
    }),
    { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
  );

  if (!manifestPath) {
    return new Set<string>();
  }

  return getOrCompute(`dependency-universe\0${manifestPath}`, () => ({
    value: parseDependencyUniverse(manifestPath),
    dependencies: [manifestPath],
  }));
}

/**
 * Extracts the installable package name from a bare import specifier.
 *
 * @param specifier raw import specifier, optionally including a package subpath
 */
export function extractPackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

function findNearestManifest(
  fileDir: FsPath,
  rootDir: FsPath,
): FsPath | undefined {
  const fs = getFs();
  const normalizedRootDir = normalizePath(rootDir);
  let currentDirectory = fileDir;

  while (true) {
    const manifestPath = fs.join(currentDirectory, 'package.json');
    if (fs.exists(manifestPath) && fs.isFile(manifestPath)) {
      return manifestPath;
    }

    if (normalizePath(currentDirectory) === normalizedRootDir) {
      return undefined;
    }

    const parent = fs.getParent(currentDirectory);
    // On win32, drive-letter casing can keep the normalized root comparison
    // from matching. Stop when the filesystem reports a self-parent root.
    if (parent === currentDirectory) {
      return undefined;
    }

    currentDirectory = parent;
  }
}

function parseDependencyUniverse(manifestPath: FsPath): Set<string> {
  try {
    const manifest = JSON.parse(
      getFs().readFile(manifestPath),
    ) as DependencyManifest;
    return new Set([
      ...getDependencyNames(manifest.dependencies),
      ...getDependencyNames(manifest.peerDependencies),
      ...getDependencyNames(manifest.optionalDependencies),
    ]);
  } catch {
    return new Set<string>();
  }
}

function getDependencyNames(section: unknown): string[] {
  return section !== null &&
    typeof section === 'object' &&
    !Array.isArray(section)
    ? Object.keys(section)
    : [];
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isOutsideRoot(relativePath: string, isAbsolute: boolean): boolean {
  return relativePath === '..' || relativePath.startsWith('../') || isAbsolute;
}
