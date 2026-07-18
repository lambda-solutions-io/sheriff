import { FsPath } from './fs-path';
import getFs from '../fs/getFs';

type DependencyManifest = {
  dependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
};

type DependencyUniverseCache = {
  manifestByDirectory: Map<string, FsPath | undefined>;
  universeByManifest: Map<FsPath, Set<string>>;
};

const cacheByFilesystemGeneration = new WeakMap<
  object,
  DependencyUniverseCache
>();

/**
 * Finds the nearest package manifest within `rootDir` and returns the package
 * names declared as runtime, peer, or optional dependencies.
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

  const cache = getCache();
  const normalizedRootDir = normalizePath(rootDir);
  const visitedDirectories: string[] = [];
  let currentDirectory = fileDir;

  while (true) {
    const directoryCacheKey = createDirectoryCacheKey(
      currentDirectory,
      normalizedRootDir,
    );
    visitedDirectories.push(directoryCacheKey);

    if (cache.manifestByDirectory.has(directoryCacheKey)) {
      const cachedManifest = cache.manifestByDirectory.get(directoryCacheKey);
      cacheVisitedDirectories(cache, visitedDirectories, cachedManifest);
      return cachedManifest
        ? getUniverseFromManifest(cachedManifest, cache)
        : new Set<string>();
    }

    const manifestPath = fs.join(currentDirectory, 'package.json');
    if (fs.exists(manifestPath) && fs.isFile(manifestPath)) {
      cacheVisitedDirectories(cache, visitedDirectories, manifestPath);
      return getUniverseFromManifest(manifestPath, cache);
    }

    if (normalizePath(currentDirectory) === normalizedRootDir) {
      cacheVisitedDirectories(cache, visitedDirectories, undefined);
      return new Set<string>();
    }

    const parent = fs.getParent(currentDirectory);
    // On win32, drive-letter casing can keep the normalized root comparison
    // from matching. Stop when the filesystem reports a self-parent root.
    if (parent === currentDirectory) {
      cacheVisitedDirectories(cache, visitedDirectories, undefined);
      return new Set<string>();
    }

    currentDirectory = parent;
  }
}

/**
 * Clears cached dependency manifests for the active filesystem generation.
 *
 * Sheriff calls this at the start of every fresh run so long-lived processes
 * re-read package manifests with the same lifetime as config and tsconfig.
 */
export function clearDependencyUniverseCache(): void {
  cacheByFilesystemGeneration.delete(getFilesystemGeneration());
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

function getCache(): DependencyUniverseCache {
  const filesystemGeneration = getFilesystemGeneration();
  const cached = cacheByFilesystemGeneration.get(filesystemGeneration);

  if (cached) {
    return cached;
  }

  const cache: DependencyUniverseCache = {
    manifestByDirectory: new Map(),
    universeByManifest: new Map(),
  };
  cacheByFilesystemGeneration.set(filesystemGeneration, cache);
  return cache;
}

function getFilesystemGeneration(): object {
  const fs = getFs();
  const virtualFsRoot = (fs as typeof fs & { root?: object }).root;
  return virtualFsRoot ?? fs;
}

function getUniverseFromManifest(
  manifestPath: FsPath,
  cache: DependencyUniverseCache,
): Set<string> {
  const cached = cache.universeByManifest.get(manifestPath);
  if (cached) {
    return cached;
  }

  const universe = parseDependencyUniverse(manifestPath);
  cache.universeByManifest.set(manifestPath, universe);
  return universe;
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

function cacheVisitedDirectories(
  cache: DependencyUniverseCache,
  directoryCacheKeys: string[],
  manifestPath: FsPath | undefined,
): void {
  for (const directoryCacheKey of directoryCacheKeys) {
    cache.manifestByDirectory.set(directoryCacheKey, manifestPath);
  }
}

function createDirectoryCacheKey(
  directory: FsPath,
  normalizedRootDir: string,
): string {
  return `${normalizedRootDir}\0${normalizePath(directory)}`;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isOutsideRoot(relativePath: string, isAbsolute: boolean): boolean {
  return relativePath === '..' || relativePath.startsWith('../') || isAbsolute;
}
