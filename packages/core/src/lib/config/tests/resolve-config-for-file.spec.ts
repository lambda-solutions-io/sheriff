import { describe, it, expect } from 'vitest';
import { resolveConfigForFile } from '../resolve-config-for-file';
import { FsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

/**
 * Task 4, option B. `configs` maps a workspace-relative directory to the
 * config file governing it. The deepest matching entry wins; anything not
 * covered falls back to the root config (`undefined`).
 *
 * These are pure path computations, so no virtual filesystem is needed.
 */
const rootDir = '/project' as FsPath;

const configs = {
  'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
  'apps/vertical-demo': './apps/vertical-demo/sheriff.config.ts',
};

describe('config resolution', () => {
  it('should return undefined when no configs are declared', () => {
    // the control: single-config setups must stay untouched
    expect(
      resolveConfigForFile(
        '/project/apps/hexagonal-demo/src/main.ts' as FsPath,
        rootDir,
        {},
      ),
    ).toBeUndefined();
  });

  it('should return undefined for a file outside every declared directory', () => {
    expect(
      resolveConfigForFile('/project/libs/shared/src/util.ts' as FsPath, rootDir, configs),
    ).toBeUndefined();
  });

  it('should resolve the config of the directory containing the file', () => {
    expect(
      resolveConfigForFile(
        '/project/apps/hexagonal-demo/src/main.ts' as FsPath,
        rootDir,
        configs,
      ),
    ).toBe('./apps/hexagonal-demo/sheriff.config.ts');
  });

  it('should keep the two architectures apart', () => {
    // the point of the whole feature: same workspace, different vocabularies
    expect(
      resolveConfigForFile(
        '/project/apps/vertical-demo/src/main.ts' as FsPath,
        rootDir,
        configs,
      ),
    ).toBe('./apps/vertical-demo/sheriff.config.ts');
  });

  it('should resolve a file lying directly in the declared directory', () => {
    expect(
      resolveConfigForFile(
        '/project/apps/hexagonal-demo/main.ts' as FsPath,
        rootDir,
        configs,
      ),
    ).toBe('./apps/hexagonal-demo/sheriff.config.ts');
  });

  it('should let the deepest entry win', () => {
    expect(
      resolveConfigForFile(
        '/project/apps/demo/feature/src/main.ts' as FsPath,
        rootDir,
        {
          apps: './apps/sheriff.config.ts',
          'apps/demo': './apps/demo/sheriff.config.ts',
          'apps/demo/feature': './apps/demo/feature/sheriff.config.ts',
        },
      ),
    ).toBe('./apps/demo/feature/sheriff.config.ts');
  });

  it('should let the deepest entry win regardless of key order', () => {
    expect(
      resolveConfigForFile(
        '/project/apps/demo/feature/src/main.ts' as FsPath,
        rootDir,
        {
          'apps/demo/feature': './apps/demo/feature/sheriff.config.ts',
          'apps/demo': './apps/demo/sheriff.config.ts',
          apps: './apps/sheriff.config.ts',
        },
      ),
    ).toBe('./apps/demo/feature/sheriff.config.ts');
  });

  it('should not match a directory which is only a string prefix', () => {
    // 'apps/demo' must not capture 'apps/demo-two' - the boundary is a
    // path segment, not a character offset
    expect(
      resolveConfigForFile(
        '/project/apps/demo-two/src/main.ts' as FsPath,
        rootDir,
        { 'apps/demo': './apps/demo/sheriff.config.ts' },
      ),
    ).toBeUndefined();
  });
});
