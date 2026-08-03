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

/**
 * Test-only instrumentation for the multi-entry benchmark spec. The
 * counters are OFF by default: they only increment when
 * `SHERIFF_CACHE_STATS=1`, so the production hot path does zero extra
 * work. This is global state deliberately independent of
 * `clearProjectCache` (which drops cache entries, not measurements);
 * a test resets it explicitly via `resetCacheStats`. Not part of the
 * public API and not re-exported from `packages/core/src/index.ts`.
 */
const cacheStats = { computes: 0, hits: 0 };

function isStatsEnabled(): boolean {
  return process.env['SHERIFF_CACHE_STATS'] === '1';
}

export function getCacheStats(): { computes: number; hits: number } {
  return { ...cacheStats };
}

export function resetCacheStats(): void {
  cacheStats.computes = 0;
  cacheStats.hits = 0;
}

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
  const countStats = isStatsEnabled();

  if (isCachingDisabled()) {
    if (countStats) cacheStats.computes++;
    return compute().value;
  }

  const entries = getEntriesForActiveGeneration();
  const cached = entries.get(key) as CacheEntry<T> | undefined;
  if (cached && isFresh(cached)) {
    if (countStats) cacheStats.hits++;
    return cached.value;
  }

  if (countStats) cacheStats.computes++;
  const computeStart = snapshotComputeStart();
  const { value, dependencies } = compute();
  entries.set(
    key,
    createEntry(value, dependencies, options.ttlMs, computeStart),
  );
  return value;
}

export function clearProjectCache(): void {
  cacheByFilesystemGeneration.delete(getFilesystemGeneration());
}

/**
 * Drops one cache entry from the active filesystem generation.
 *
 * Used by bounded higher-level caches which keep their own eviction order.
 */
export function deleteProjectCacheEntry(key: string): void {
  getEntriesForActiveGeneration().delete(key);
}

/**
 * Drops all entries depending on the given file. Used by the daemon's
 * watcher to invalidate exactly instead of waiting for mtime checks.
 */
export function invalidatePath(path: FsPath): void {
  const entries = getEntriesForActiveGeneration();
  for (const [key, entry] of entries) {
    if (entry.dependencies.some((dependency) => dependency.path === path)) {
      entries.delete(key);
    }
  }
}

/**
 * Drops all structure-dependent (TTL) entries. Used by the daemon's
 * watcher when files or directories are added or removed.
 */
export function invalidateStructure(): void {
  const entries = getEntriesForActiveGeneration();
  for (const [key, entry] of entries) {
    if (entry.expiresAt !== undefined || entry.writeClock !== undefined) {
      entries.delete(key);
    }
  }
}

/**
 * Snapshot taken right before `compute` runs. Dependencies are only known
 * after `compute` returns, so their stamps are collected afterwards — but a
 * write landing *during* the computation must not be stamped as if its
 * content had been incorporated (TOCTOU, #43). The snapshot marks the
 * boundary: on the `VirtualFs` the write clock detects a concurrent write
 * exactly; on the real fs an mtime at or after the compute start counts as
 * concurrent.
 */
type ComputeStart = {
  writeClock: number | undefined;
  startedAt: number;
};

function snapshotComputeStart(): ComputeStart {
  return { writeClock: getWriteClock(getFs()), startedAt: Date.now() };
}

function createEntry<T>(
  value: T,
  dependencies: FsPath[],
  ttlMs: number | undefined,
  computeStart: ComputeStart,
): CacheEntry<T> {
  const fs = getFs();
  const isStructureDependent = ttlMs !== undefined;

  return {
    value,
    dependencies: dependencies.map((path) => ({
      path,
      lastModified: stampLastModified(fs, path, computeStart),
    })),
    expiresAt: isStructureDependent
      ? Date.now() + resolveTtlMs(ttlMs)
      : undefined,
    // the pre-compute clock, so a write during compute makes the entry stale
    writeClock: isStructureDependent ? computeStart.writeClock : undefined,
  };
}

/**
 * Stamps `NaN` (permanently stale, like a vanished dependency) when the
 * dependency was written while `compute` was running: the value may derive
 * from the previous content, so the next lookup must recompute. The
 * recompute then observes a settled mtime and caches normally.
 */
function stampLastModified(
  fs: Fs,
  path: FsPath,
  computeStart: ComputeStart,
): number {
  const lastModified = safeLastModified(fs, path);
  const wasWrittenDuringCompute =
    computeStart.writeClock !== undefined
      ? lastModified > computeStart.writeClock
      : lastModified >= computeStart.startedAt;
  return wasWrittenDuringCompute ? NaN : lastModified;
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
  const ttlOverride = process.env['SHERIFF_CACHE_TTL']?.trim();
  if (!ttlOverride) {
    return ttlMs;
  }

  const override = Number(ttlOverride);
  return Number.isFinite(override) && override >= 0 ? override : ttlMs;
}
