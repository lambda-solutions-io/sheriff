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

  it('should recompute when a dependency is written while compute runs', () => {
    // TOCTOU (#43): compute reads version A; an editor save lands with
    // version B before compute returns. The A-derived result must not be
    // served as fresh afterwards.
    const mainTs = writeMain('A');
    let simulateConcurrentWrite = true;
    const compute = vi.fn(() => {
      const value = fs.readFile(mainTs);
      if (simulateConcurrentWrite) {
        simulateConcurrentWrite = false;
        fs.writeFile('/project/main.ts', 'B');
      }
      return { value, dependencies: [mainTs] };
    });

    expect(getOrCompute('the-key', compute)).toBe('A');
    expect(getOrCompute('the-key', compute)).toBe('B');
    expect(compute).toHaveBeenCalledTimes(2);

    // once the dependency is stable again, the entry caches normally
    expect(getOrCompute('the-key', compute)).toBe('B');
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

  it('should invalidate a structure-dependent entry written to during compute', () => {
    writeMain();
    let simulateConcurrentWrite = true;
    const compute = vi.fn(() => {
      if (simulateConcurrentWrite) {
        simulateConcurrentWrite = false;
        fs.writeFile('/project/feature/index.ts', '');
      }
      return { value: 42, dependencies: [] };
    });

    getOrCompute('the-key', compute, { ttlMs: 60_000 });
    getOrCompute('the-key', compute, { ttlMs: 60_000 });
    expect(compute).toHaveBeenCalledTimes(2);

    getOrCompute('the-key', compute, { ttlMs: 60_000 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should recompute after a mid-compute write on the default fs', () => {
    // Real-fs variant of the TOCTOU race: the concurrent write is made
    // deterministic by pushing the mtime into the future, so it always
    // lands at/after the compute start regardless of timer resolution.
    useDefaultFs();
    clearProjectCache();
    const temporaryDirectory = nodeFs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-cache-'),
    );
    const mainTsPath = path.join(temporaryDirectory, 'main.ts');

    try {
      nodeFs.writeFileSync(mainTsPath, 'A');
      const settled = new Date(Date.now() - 60_000);
      nodeFs.utimesSync(mainTsPath, settled, settled);
      const mainTs = toFsPath(mainTsPath);

      let simulateConcurrentWrite = true;
      const compute = vi.fn(() => {
        const value = nodeFs.readFileSync(mainTsPath, 'utf8');
        if (simulateConcurrentWrite) {
          simulateConcurrentWrite = false;
          nodeFs.writeFileSync(mainTsPath, 'B');
          const future = new Date(Date.now() + 600_000);
          nodeFs.utimesSync(mainTsPath, future, future);
        }
        return { value, dependencies: [mainTs] };
      });

      expect(getOrCompute('the-key', compute)).toBe('A');
      expect(getOrCompute('the-key', compute)).toBe('B');
      expect(compute).toHaveBeenCalledTimes(2);
    } finally {
      nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('should cache a dependency written in the same millisecond as the compute start', () => {
    // `Date.now()` is whole-ms while `mtimeMs` is fractional on APFS/ext4.
    // Comparing them raw made a file written just before `getOrCompute`
    // look concurrent, stamping NaN and turning the entry into a permanent
    // cache miss. Freshly written fixtures are the common case, so this must
    // cache on the second call.
    useDefaultFs();
    clearProjectCache();
    const temporaryDirectory = nodeFs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-cache-'),
    );
    const mainTsPath = path.join(temporaryDirectory, 'main.ts');

    try {
      nodeFs.writeFileSync(mainTsPath, 'A');
      const mainTs = toFsPath(mainTsPath);
      const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

      expect(getOrCompute('the-key', compute)).toBe(42);
      expect(getOrCompute('the-key', compute)).toBe(42);
      expect(compute).toHaveBeenCalledTimes(1);
    } finally {
      nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
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
      vi.setSystemTime(10_000);
      vi.stubEnv('SHERIFF_CACHE_TTL', ttlOverride);
      useDefaultFs();
      clearProjectCache();
      const temporaryDirectory = nodeFs.mkdtempSync(
        path.join(os.tmpdir(), 'sheriff-cache-'),
      );
      const mainTsPath = path.join(temporaryDirectory, 'main.ts');

      try {
        nodeFs.writeFileSync(mainTsPath, 'export const a = 1;');
        // backdate below the fake clock, otherwise the real mtime looks
        // like a mid-compute write and permanently invalidates the entry
        nodeFs.utimesSync(mainTsPath, new Date(1_000), new Date(1_000));
        const mainTs = toFsPath(mainTsPath);
        const compute = vi.fn(() => ({ value: 42, dependencies: [mainTs] }));

        getOrCompute(`ttl-${JSON.stringify(ttlOverride)}`, compute, {
          ttlMs: 1_000,
        });
        vi.setSystemTime(10_001);
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
