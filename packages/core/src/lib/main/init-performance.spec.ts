import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProjectCache,
  getCacheStats,
  resetCacheStats,
} from '../cache/project-cache';
import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { findClosestModulePath } from '../modules/create-modules';
import {
  createSyntheticProject,
  initSyntheticProject,
} from '../test/synthetic-project';
import { init } from './init';

describe('init performance operation budgets', () => {
  let previousStatsFlag: string | undefined;

  beforeEach(() => {
    previousStatsFlag = process.env['SHERIFF_CACHE_STATS'];
    process.env['SHERIFF_CACHE_STATS'] = '1';
    clearProjectCache();
    resetCacheStats();
  });

  afterEach(() => {
    if (previousStatsFlag === undefined) {
      delete process.env['SHERIFF_CACHE_STATS'];
    } else {
      process.env['SHERIFF_CACHE_STATS'] = previousStatsFlag;
    }
  });

  it('computes each source analysis once and reuses every result on warm init', () => {
    const project = createSyntheticProject({
      domains: 4,
      modulesPerDomain: 3,
      filesPerModule: 4,
    });

    const { cacheStats: coldStats } = initSyntheticProject(project);

    // One compute per source file, plus tsconfig, Sheriff config, and the
    // barrel-module directory scan. No compute may grow with file x module.
    expect(coldStats).toEqual({
      computes: project.fileCount + 3,
      hits: 0,
    });

    resetCacheStats();
    init(project.entryFile);

    expect(getCacheStats()).toEqual({
      computes: 0,
      hits: project.fileCount + 3,
    });
  });

  it('bounds module assignment by path depth instead of module count', () => {
    const project = createSyntheticProject({
      domains: 8,
      modulesPerDomain: 4,
      filesPerModule: 5,
    });
    const irrelevantModulePaths = Array.from({ length: 2_000 }, (_, index) => {
      const path = `/project/irrelevant/module-${index}`;
      getFs().createDir(path);
      return toFsPath(path);
    });
    const modulePaths = new CountingSet<FsPath>([
      toFsPath('/project'),
      ...project.modulePaths,
      ...irrelevantModulePaths,
    ]);

    for (const path of project.sourceFilePaths) {
      findClosestModulePath(path, modulePaths, toFsPath('/project'));
    }

    // Module files and barrels need two probes (file, containing module).
    // src/main.ts needs three (file, src, root). The 2,000 unrelated module
    // paths do not add work.
    expect(modulePaths.hasCalls).toBe(project.fileCount * 2 + 1);
  });
});

class CountingSet<T> extends Set<T> {
  hasCalls = 0;

  override has(value: T): boolean {
    this.hasCalls++;
    return super.has(value);
  }
}
