import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import getFs, { useVirtualFs } from '../fs/getFs';
import { VirtualFs } from '../fs/virtual-fs';
import { toFsPath } from '../file-info/fs-path';
import { clearProjectCache, getOrCompute } from './project-cache';

describe('project cache', () => {
  let fs: VirtualFs;

  beforeAll(() => {
    useVirtualFs();
    fs = getFs() as VirtualFs;
  });

  beforeEach(() => {
    fs.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const writeMain = (contents = 'export const a = 1;') => {
    fs.writeFile('/project/main.ts', contents);
    return toFsPath('/project/main.ts');
  };

  it('should compute once for an unchanged dependency', () => {
    const mainTs = writeMain();
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    expect(getOrCompute('the-key', compute)).toBe(42);
    expect(getOrCompute('the-key', compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('should recompute when a dependency changes', () => {
    const mainTs = writeMain();
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    getOrCompute('the-key', compute);
    fs.writeFile('/project/main.ts', 'export const a = 2;');
    getOrCompute('the-key', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should recompute when a dependency vanishes', () => {
    fs.writeFile('/project/sub/main.ts', 'export const a = 1;');
    const mainTs = toFsPath('/project/sub/main.ts');
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    getOrCompute('the-key', compute);
    fs.removeDir(toFsPath('/project/sub'));
    getOrCompute('the-key', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should key entries separately', () => {
    const mainTs = writeMain();
    const compute1 = vi.fn(() => ({ value: 1, dependencies: [mainTs] }));
    const compute2 = vi.fn(() => ({ value: 2, dependencies: [mainTs] }));

    expect(getOrCompute('key1', compute1)).toBe(1);
    expect(getOrCompute('key2', compute2)).toBe(2);
  });

  it('should isolate cache entries per filesystem generation', () => {
    const mainTs = writeMain();
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    getOrCompute('the-key', compute);
    fs.reset();
    writeMain();
    getOrCompute('the-key', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should invalidate structure-dependent entries on any write', () => {
    writeMain();
    const compute = vi.fn(() => ({ value: 42, dependencies: [] }));

    getOrCompute('the-key', compute, { ttlMs: 60_000 });
    getOrCompute('the-key', compute, { ttlMs: 60_000 });
    expect(compute).toHaveBeenCalledTimes(1);

    fs.writeFile('/project/feature/index.ts', '');
    getOrCompute('the-key', compute, { ttlMs: 60_000 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should bypass the cache with SHERIFF_NO_CACHE', () => {
    vi.stubEnv('SHERIFF_NO_CACHE', '1');
    const mainTs = writeMain();
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    getOrCompute('the-key', compute);
    getOrCompute('the-key', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should recompute after clearProjectCache', () => {
    const mainTs = writeMain();
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    getOrCompute('the-key', compute);
    clearProjectCache();
    getOrCompute('the-key', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });
});
