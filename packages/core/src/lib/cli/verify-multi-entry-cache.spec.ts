import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toFsPath } from '../file-info/fs-path';
import { useDefaultFs } from '../fs/getFs';
import { init } from '../main/init';
import {
  clearProjectCache,
  getCacheStats,
  resetCacheStats,
} from '../cache/project-cache';

/**
 * What these specs prove (and what they do NOT):
 *
 * The process-level cache in `project-cache.ts` already deduplicates work
 * across successive `init` calls WITHIN a single process run. Two app
 * entries that share a nearest `tsconfig.json` reuse each other's cached
 * config/tsconfig/module-path/import-resolution computations, so a warm
 * second entry does strictly fewer computes than a cold one. That is the
 * regression this suite guards; no additional in-run optimization is
 * warranted.
 *
 * Boundary (out of scope for this change): entries whose nearest
 * `tsconfig.json` DIFFERS do not share import-resolution work, because the
 * `traverse-filesystem` import-resolutions cache key is prefixed by
 * `tsData.sourceConfigPaths[0]` (the entry's own tsconfig). Such files are
 * re-resolved per entry. Cross-tsconfig sharing would be a separate,
 * riskier change and is not attempted here.
 *
 * The `SHERIFF_CACHE_STATS=1` flag turns on the otherwise-zero-overhead
 * compute/hit counters used below; `SHERIFF_CACHE_TTL` is pinned high so
 * the ~2s structure-cache TTL cannot expire mid-test on slow CI and flake
 * the "zero extra computes" assertion.
 */

const fixtureDir = path.resolve(
  __dirname,
  '../../../../../test-projects/angular-v-multi',
);
const entryPath = (relativePath: string) =>
  toFsPath(path.resolve(fixtureDir, relativePath));

const APP_I_MAIN = 'projects/app-i/src/main.ts';
const APP_II_MAIN = 'projects/app-ii/src/main.ts';
const APP_I_ROUTES = 'projects/app-i/src/app/app.routes.ts';

describe('multi-entry verify reuses process caches across entry points', () => {
  let previousStatsFlag: string | undefined;
  let previousTtl: string | undefined;

  beforeEach(() => {
    previousStatsFlag = process.env['SHERIFF_CACHE_STATS'];
    previousTtl = process.env['SHERIFF_CACHE_TTL'];
    // Enable the opt-in instrumentation and pin the structure-cache TTL far
    // beyond any realistic test duration so a slow run cannot expire entries
    // mid-test.
    process.env['SHERIFF_CACHE_STATS'] = '1';
    process.env['SHERIFF_CACHE_TTL'] = String(60 * 60 * 1000);

    useDefaultFs();
    clearProjectCache();
    resetCacheStats();
  });

  afterEach(() => {
    if (previousStatsFlag === undefined) {
      delete process.env['SHERIFF_CACHE_STATS'];
    } else {
      process.env['SHERIFF_CACHE_STATS'] = previousStatsFlag;
    }
    if (previousTtl === undefined) {
      delete process.env['SHERIFF_CACHE_TTL'];
    } else {
      process.env['SHERIFF_CACHE_TTL'] = previousTtl;
    }
  });

  // Measures the computes attributable to `init(entry)` given whatever is
  // already in the cache, then leaves the cache as-is for the caller.
  const computesFor = (entry: string): number => {
    resetCacheStats();
    init(entryPath(entry));
    return getCacheStats().computes;
  };

  it('shares cross-entry work: warm second entry does strictly fewer computes than a cold one', () => {
    // Two DISJOINT application entries that share a nearest tsconfig.json.
    // They have no source files in common, so any compute reduction on the
    // second entry can only come from reusing shared infrastructure
    // (root tsconfig, dependency universe, module paths) cached by the first.

    // Warm condition: first entry populates the cache, second entry reuses it.
    init(entryPath(APP_I_MAIN));
    const warmSecondEntryComputes = computesFor(APP_II_MAIN);

    // Cold-between condition: identical sequence, but the cache is cleared
    // between the two entries so nothing carries over.
    clearProjectCache();
    resetCacheStats();
    init(entryPath(APP_I_MAIN));
    clearProjectCache();
    const coldSecondEntryComputes = computesFor(APP_II_MAIN);

    // If the cache were cleared between entries, the second entry redoes all
    // the shared work. Reusing it must genuinely reduce computes.
    expect(coldSecondEntryComputes).toBeGreaterThan(0);
    expect(warmSecondEntryComputes).toBeLessThan(coldSecondEntryComputes);
  });

  it('resolves files shared by overlapping entries only once', () => {
    init(entryPath(APP_I_MAIN));
    const afterMainEntry = getCacheStats();

    // app.routes.ts is already reachable from main.ts through app.config.ts,
    // so re-entering at it adds no new computes and only produces cache hits.
    init(entryPath(APP_I_ROUTES));
    const afterOverlappingEntry = getCacheStats();

    expect(afterOverlappingEntry.computes).toBe(afterMainEntry.computes);
    expect(afterOverlappingEntry.hits).toBeGreaterThan(afterMainEntry.hits);
  });
});
