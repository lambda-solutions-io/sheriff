import getFs from '../fs/getFs';
import { Fs } from '../fs/fs';
import { FsPath } from '../file-info/fs-path';

/**
 * Process-level cache for expensive, filesystem-derived computations
 * (parsed configs, tsconfig data, module paths, import resolutions).
 *
 * Entries are keyed by the active filesystem generation (same pattern as
 * `dependency-universe.ts`): the `VirtualFs` root object or the `DefaultFs`
 * singleton. A `fs.reset()` in tests creates a new root and thereby an
 * empty cache, so virtual-fs tests are isolated for free.
 *
 * Freshness:
 * - Entries carry dependency stamps (`lastModified` per file) which are
 *   validated on every read. A changed or vanished dependency invalidates.
 * - Entries created with a `ttlMs` depend on directory *structure* which
 *   cannot be validated via file mtimes. They expire after the TTL window.
 *   On the `VirtualFs` the global write clock replaces the TTL, making
 *   structural invalidation exact in tests.
 *
 * `SHERIFF_NO_CACHE=1` disables reads and writes entirely,
 * `SHERIFF_CACHE_TTL=<ms>` overrides the staleness window.
 */

type DependencyStamp = { path: FsPath; lastModified: number };

type CacheEntry<T> = {
  value: T;
  dependencies: DependencyStamp[];
  expiresAt: number | undefined;
  writeClock: number | undefined;
};

const cacheByFilesystemGeneration = new WeakMap<
  object,
  Map<string, CacheEntry<unknown>>
>();

export const DEFAULT_STRUCTURE_CACHE_TTL_MS = 2_000;

export type ComputedWithDependencies<T> = {
  value: T;
  dependencies: FsPath[];
};

type GetOrComputeOptions = {
  /** Marks the entry as structure-dependent with a staleness window. */
  ttlMs?: number;
};

export function getOrCompute<T>(
  key: string,
  compute: () => ComputedWithDependencies<T>,
  options: GetOrComputeOptions = {},
): T {
  if (isCachingDisabled()) {
    return compute().value;
  }

  const entries = getEntriesForActiveGeneration();
  const cached = entries.get(key) as CacheEntry<T> | undefined;
  if (cached && isFresh(cached)) {
    return cached.value;
  }

  const { value, dependencies } = compute();
  entries.set(key, createEntry(value, dependencies, options.ttlMs));
  return value;
}

export function clearProjectCache(): void {
  cacheByFilesystemGeneration.delete(getFilesystemGeneration());
}

function createEntry<T>(
  value: T,
  dependencies: FsPath[],
  ttlMs: number | undefined,
): CacheEntry<T> {
  const fs = getFs();
  const isStructureDependent = ttlMs !== undefined;
  const writeClock = getWriteClock(fs);

  return {
    value,
    dependencies: dependencies.map((path) => ({
      path,
      lastModified: safeLastModified(fs, path),
    })),
    expiresAt: isStructureDependent
      ? Date.now() + resolveTtlMs(ttlMs)
      : undefined,
    writeClock: isStructureDependent ? writeClock : undefined,
  };
}

function isFresh(entry: CacheEntry<unknown>): boolean {
  if (entry.writeClock !== undefined) {
    if (entry.writeClock !== getWriteClock(getFs())) {
      return false;
    }
  } else if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
    return false;
  }

  return entry.dependencies.every(isDependencyUnchanged);
}

function isDependencyUnchanged({ path, lastModified }: DependencyStamp) {
  try {
    return getFs().lastModified(path) === lastModified;
  } catch {
    // dependency vanished
    return false;
  }
}

/**
 * A dependency can vanish between compute and stamping. `NaN` never
 * equals a real marker, so such an entry is permanently stale instead
 * of crashing the write.
 */
function safeLastModified(fs: Fs, path: FsPath): number {
  try {
    return fs.lastModified(path);
  } catch {
    return NaN;
  }
}

function getEntriesForActiveGeneration(): Map<string, CacheEntry<unknown>> {
  const generation = getFilesystemGeneration();
  const cached = cacheByFilesystemGeneration.get(generation);
  if (cached) {
    return cached;
  }

  const entries = new Map<string, CacheEntry<unknown>>();
  cacheByFilesystemGeneration.set(generation, entries);
  return entries;
}

function getFilesystemGeneration(): object {
  const fs = getFs();
  const virtualFsRoot = (fs as typeof fs & { root?: object }).root;
  return virtualFsRoot ?? fs;
}

function getWriteClock(fs: Fs): number | undefined {
  return (fs as Fs & { writeClock?: number }).writeClock;
}

function isCachingDisabled(): boolean {
  const flag = process.env['SHERIFF_NO_CACHE'];
  return flag === '1' || flag === 'true';
}

function resolveTtlMs(ttlMs: number): number {
  const override = Number(process.env['SHERIFF_CACHE_TTL']);
  return Number.isFinite(override) && override >= 0 ? override : ttlMs;
}
