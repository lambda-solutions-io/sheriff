import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import getFs, { useDefaultFs, useVirtualFs } from '../fs/getFs';
import { VirtualFs } from '../fs/virtual-fs';
import { toFsPath } from '../file-info/fs-path';
import {
  clearProjectCache,
  getOrCompute,
  invalidatePath,
  invalidateStructure,
} from './project-cache';

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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    clearProjectCache();
    useVirtualFs();
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

  it.each(['', '   '])(
    'should treat blank SHERIFF_CACHE_TTL as unset',
    (ttlOverride) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      vi.stubEnv('SHERIFF_CACHE_TTL', ttlOverride);
      useDefaultFs();
      clearProjectCache();
      const temporaryDirectory = nodeFs.mkdtempSync(
        path.join(os.tmpdir(), 'sheriff-cache-'),
      );
      const mainTsPath = path.join(temporaryDirectory, 'main.ts');

      try {
        nodeFs.writeFileSync(mainTsPath, 'export const a = 1;');
        const mainTs = toFsPath(mainTsPath);
        const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

        getOrCompute(`ttl-${JSON.stringify(ttlOverride)}`, compute, {
          ttlMs: 1_000,
        });
        vi.setSystemTime(1);
        getOrCompute(`ttl-${JSON.stringify(ttlOverride)}`, compute, {
          ttlMs: 1_000,
        });

        expect(compute).toHaveBeenCalledTimes(1);
      } finally {
        nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );

  it('should recompute after invalidatePath for a dependency', () => {
    const mainTs = writeMain();
    fs.writeFile('/project/other.ts', '');
    const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

    getOrCompute('the-key', compute);
    invalidatePath(toFsPath('/project/other.ts'));
    getOrCompute('the-key', compute);
    expect(compute).toHaveBeenCalledTimes(1);

    invalidatePath(mainTs);
    getOrCompute('the-key', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should drop only structure-dependent entries on invalidateStructure', () => {
    const mainTs = writeMain();
    const computeExact = vi.fn(() => ({ value: 1, dependencies: [mainTs] }));
    const computeStructure = vi.fn(() => ({ value: 2, dependencies: [] }));

    getOrCompute('exact', computeExact);
    getOrCompute('structure', computeStructure, { ttlMs: 60_000 });

    invalidateStructure();

    getOrCompute('exact', computeExact);
    getOrCompute('structure', computeStructure, { ttlMs: 60_000 });

    expect(computeExact).toHaveBeenCalledTimes(1);
    expect(computeStructure).toHaveBeenCalledTimes(2);
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
