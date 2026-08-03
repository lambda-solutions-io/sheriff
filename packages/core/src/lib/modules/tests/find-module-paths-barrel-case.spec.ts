import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { useDefaultFs, useVirtualFs } from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { defaultConfig } from '../../config/default-config';
import { findModulePaths } from '../find-module-paths';

/**
 * Residual of issue #70: barrel DISCOVERY (`findFiles`) is case-sensitive,
 * but the `hasBarrel` probes in `findModulePaths` and
 * `findModulePathsWithoutBarrel` used `fs.exists`, which on case-insensitive
 * filesystems (macOS/Windows) matches case-variants via `existsSync`. A
 * configured module with an on-disk `Index.ts` and `barrelFileName:
 * 'index.ts'` was flagged `hasBarrel: true` (or dropped from the barrel-less
 * set) while `Module.exposes` compares exact paths - the same
 * exposes-nothing broken-module state #70 fixed for discovery.
 *
 * These tests need a real filesystem: the VirtualFs `exists` is
 * case-sensitive, so the mismatch is invisible there. On a case-sensitive
 * filesystem the case-variant scenarios cannot reproduce the bug and skip
 * themselves.
 */

let temporaryDirectory: string;
let caseInsensitiveFs = false;

function createModuleTree(barrelFileOnDisk: string): {
  rootDir: ReturnType<typeof toFsPath>;
  customersDir: string;
} {
  const rootDir = nodeFs.mkdtempSync(
    path.join(temporaryDirectory, 'project-'),
  );
  const customersDir = path.join(rootDir, 'modules', 'customers');
  nodeFs.mkdirSync(customersDir, { recursive: true });
  nodeFs.writeFileSync(path.join(customersDir, barrelFileOnDisk), '');

  return { rootDir: toFsPath(rootDir), customersDir };
}

describe('hasBarrel probe vs. barrel discovery casing (issue #70 residual)', () => {
  beforeAll(() => {
    useDefaultFs();
    temporaryDirectory = nodeFs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-barrel-case-'),
    );
    // detect filesystem case rules with a probe file: the case-variant
    // scenarios are only meaningful where `existsSync` folds case
    nodeFs.writeFileSync(path.join(temporaryDirectory, 'probe.ts'), '');
    caseInsensitiveFs = nodeFs.existsSync(
      path.join(temporaryDirectory, 'PROBE.ts'),
    );
  });

  afterAll(() => {
    nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
    useVirtualFs().reset();
  });

  afterEach(() => {
    useDefaultFs();
  });

  describe("moduleIdentity: 'config'", () => {
    it('does not report a case-variant barrel file as hasBarrel', (context) => {
      if (!caseInsensitiveFs) {
        context.skip();
      }

      const { rootDir, customersDir } = createModuleTree('Index.ts');
      const modulePaths = findModulePaths([], rootDir, {
        ...defaultConfig,
        modules: { 'modules/<domain>': 'domain:<domain>' },
        enableBarrelLess: true,
        moduleIdentity: 'config',
      });

      // before the fix, `fs.exists` matched `Index.ts` case-insensitively:
      // hasBarrel was true while `Module.exposes` never found `index.ts`
      expect(modulePaths[toFsPath(customersDir)]).toEqual({
        hasBarrel: false,
        exports: undefined,
      });
    });

    it('reports an exact-case barrel file as hasBarrel', () => {
      const { rootDir, customersDir } = createModuleTree('index.ts');
      const modulePaths = findModulePaths([], rootDir, {
        ...defaultConfig,
        modules: { 'modules/<domain>': 'domain:<domain>' },
        enableBarrelLess: true,
        moduleIdentity: 'config',
      });

      expect(modulePaths[toFsPath(customersDir)]).toEqual({
        hasBarrel: true,
        exports: undefined,
      });
    });
  });

  describe("moduleIdentity: 'auto'", () => {
    it('keeps a configured directory with a case-variant barrel file as barrel-less module', (context) => {
      if (!caseInsensitiveFs) {
        context.skip();
      }

      const { rootDir, customersDir } = createModuleTree('Index.ts');
      const modulePaths = findModulePaths([rootDir], rootDir, {
        ...defaultConfig,
        modules: { 'modules/<domain>': 'domain:<domain>' },
        enableBarrelLess: true,
      });

      // before the fix the module vanished entirely: `fs.exists` dropped it
      // from the barrel-less set while case-sensitive discovery (correctly)
      // did not pick it up as barrel module
      expect(modulePaths[toFsPath(customersDir)]).toEqual({
        hasBarrel: false,
        exports: undefined,
      });
    });

    it('discovers an exact-case barrel file as barrel module', () => {
      const { rootDir, customersDir } = createModuleTree('index.ts');
      const modulePaths = findModulePaths([rootDir], rootDir, {
        ...defaultConfig,
        modules: { 'modules/<domain>': 'domain:<domain>' },
        enableBarrelLess: true,
      });

      expect(modulePaths[toFsPath(customersDir)]).toEqual({ hasBarrel: true });
    });
  });
});
