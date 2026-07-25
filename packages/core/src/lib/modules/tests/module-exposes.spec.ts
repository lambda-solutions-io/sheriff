import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Module, ModuleExposureConfig } from '../module';
import { FileInfo } from '../file.info';
import { toFsPath } from '../../file-info/fs-path';
import getFs, { useVirtualFs } from '../../fs/getFs';

/**
 * Direct unit tests for `Module.exposes` / `Module.kind`, the single place
 * (introduced in place of the two now-deleted helpers
 * `accessesBarrelFileForBarrelModules` / `accessesExposedFileForBarrelLessModules`
 * in `has-encapsulation-violations.ts`) that decides whether a file of a
 * module is importable from outside the module.
 *
 * `Module` is constructed directly here (bypassing `createModules`/`init`)
 * so every branch of `exposes` can be driven independently of module/file
 * discovery. All assertions reflect the behavior actually observed by
 * running these tests, not what the behavior "should" be - see the
 * comments flagging surprising results.
 */
describe('Module.exposes / Module.kind', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  afterEach(() => {
    getFs().reset();
  });

  interface CreateModuleOptions {
    path: string;
    hasBarrel: boolean;
    isRoot?: boolean;
    barrelFile?: string;
    exposureConfig: Omit<ModuleExposureConfig, 'barrelFile'>;
    exportedFilePatterns?: string[];
  }

  function createModule(options: CreateModuleOptions): Module {
    const fs = getFs();
    fs.createDir(options.path);
    const barrelFile = options.barrelFile ?? 'index.ts';

    if (options.hasBarrel) {
      // a barrel module's barrel file always exists on disk in practice;
      // `exposes` reads `barrelPath`, which requires the file to exist
      // (`toFsPath` throws otherwise), for every file of the module - not
      // only when checking the barrel file itself.
      fs.writeFile(fs.join(options.path, barrelFile), '');
    }

    const module = new Module(
      toFsPath(options.path),
      new Map(),
      () => {
        throw new Error('getFileInfo should not be called by exposes()');
      },
      options.isRoot ?? false,
      options.hasBarrel,
      { barrelFile, ...options.exposureConfig },
    );
    module.exportedFilePatterns = options.exportedFilePatterns;
    return module;
  }

  /**
   * `exposes` only ever reads `fileInfo.path`, so a minimal stand-in is
   * enough - no need to construct a full `FileInfo` via `UnassignedFileInfo`.
   */
  function fileAt(path: string): FileInfo {
    getFs().writeFile(path, '');
    return { path: toFsPath(path) } as unknown as FileInfo;
  }

  describe('kind', () => {
    it('is "barrel" for a module with a barrel file', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: true,
        exposureConfig: {
          enableBarrelLess: false,
          encapsulationPattern: 'internal',
        },
      });
      expect(module.kind).toBe('barrel');
    });

    it('is "barrel-less" for a module without a barrel file', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });
      expect(module.kind).toBe('barrel-less');
    });
  });

  describe('exposes - barrel module', () => {
    it('exposes the barrel file itself, and nothing else', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: true,
        exposureConfig: {
          enableBarrelLess: false,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/index.ts'))).toBe(true);
      expect(module.exposes(fileAt('/project/mod/other.ts'))).toBe(false);
    });

    it('is exposed the same way regardless of enableBarrelLess=true', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: true,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/index.ts'))).toBe(true);
      expect(module.exposes(fileAt('/project/mod/other.ts'))).toBe(false);
    });

    it('is exposed the same way regardless of enableBarrelLess=false', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: true,
        exposureConfig: {
          enableBarrelLess: false,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/index.ts'))).toBe(true);
      expect(module.exposes(fileAt('/project/mod/other.ts'))).toBe(false);
    });

    it('ignores exportedFilePatterns entirely', () => {
      // a barrel module's surface is always exactly the barrel file;
      // exportedFilePatterns is a barrel-less-only concept.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: true,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
        exportedFilePatterns: ['does-not-match-anything.ts'],
      });

      expect(module.exposes(fileAt('/project/mod/index.ts'))).toBe(true);
      expect(module.exposes(fileAt('/project/mod/other.ts'))).toBe(false);
    });
  });

  describe('exposes - non-barrel module with enableBarrelLess=false (the root-module case)', () => {
    it('never exposes any file, even one an exportedFilePatterns wildcard would otherwise allow', () => {
      // The enableBarrelLess gate is checked before exportedFilePatterns is
      // ever read, so a permissive exportedFilePatterns cannot leak through
      // it. This is the shape `createModules` uses for the root module
      // (hasBarrel: false, isRoot: true).
      const module = createModule({
        path: '/project',
        hasBarrel: false,
        isRoot: true,
        exposureConfig: {
          enableBarrelLess: false,
          encapsulationPattern: 'internal',
        },
        exportedFilePatterns: ['*'],
      });

      expect(module.exposes(fileAt('/project/a.ts'))).toBe(false);
      expect(module.exposes(fileAt('/project/index.ts'))).toBe(false);
    });
  });

  describe('exposes - barrel-less module, string encapsulationPattern', () => {
    it('does not expose a file directly under the pattern folder', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/internal/hidden.ts'))).toBe(
        false,
      );
    });

    it('exposes a file outside the pattern folder', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/other.ts'))).toBe(true);
    });

    it('BEHAVIOR: treats the string pattern as a plain prefix match, not a path-segment match - a file that merely starts with the pattern name is hidden too', () => {
      // `relativePath.startsWith(encapsulationPattern)` has no segment
      // boundary check, so `internal-helper.ts` is treated the same as
      // something genuinely nested under `internal/`, even though it is a
      // sibling file, not a file inside an `internal` folder.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/internal-helper.ts'))).toBe(
        false,
      );
    });

    it('encapsulates a nested "internal" folder, not only a top-level one (issue #31, finding 2)', () => {
      // Was the opposite before the depth fix: `startsWith` only looked at
      // the beginning of the relative path, so `foo/internal/x.ts` did not
      // start with `internal` and stayed exposed — silently. A directory
      // segment equal to the pattern now encapsulates at any depth.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/foo/internal/x.ts'))).toBe(
        false,
      );
    });

    it("does not special-case the module's own barrel-named file when hasBarrel is false", () => {
      // Even though `index.ts` is the conventional barrel filename, a
      // barrel-less module (hasBarrel: false) never reads `barrelPath` and
      // applies the exact same pattern-matching rule to it as to any other
      // file.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/mod/index.ts'))).toBe(true);
    });
  });

  describe('exposes - barrel-less module, RegExp encapsulationPattern', () => {
    it('does not expose a file matching the regex', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: /(^|\/)_/,
        },
      });

      expect(module.exposes(fileAt('/project/mod/_hidden.ts'))).toBe(false);
    });

    it('exposes a file not matching the regex', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: /(^|\/)_/,
        },
      });

      expect(module.exposes(fileAt('/project/mod/visible.ts'))).toBe(true);
    });

    it('unlike a string pattern, a regex anchored on "/" DOES see a match nested below the top level', () => {
      // Contrast with the string-pattern nested-folder case above: because
      // the regex is applied with `.match` (searches anywhere), not
      // `.startsWith`, `(^|/)_)` matches the `/_` inside
      // `sub/_hidden.ts` too.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: /(^|\/)_/,
        },
      });

      expect(module.exposes(fileAt('/project/mod/sub/_hidden.ts'))).toBe(false);
    });
  });

  describe('exposes - exportedFilePatterns precedence', () => {
    it('takes precedence over the encapsulation pattern: an export pattern can expose a file the encapsulation pattern would hide', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
        exportedFilePatterns: ['internal/*'],
      });

      expect(module.exposes(fileAt('/project/mod/internal/foo.ts'))).toBe(true);
    });

    it('takes precedence over the encapsulation pattern: a file the encapsulation pattern would allow stays hidden if no export pattern matches it', () => {
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        // this pattern would not hide "other.ts" if it were consulted
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'does-not-match',
        },
        exportedFilePatterns: ['only-this.ts'],
      });

      expect(module.exposes(fileAt('/project/mod/other.ts'))).toBe(false);
    });

    it('BEHAVIOR: an empty exportedFilePatterns array exposes nothing at all, even a file the encapsulation pattern would allow', () => {
      // `[].some(...)` is always `false`, so `exportedFilePatterns: []`
      // seals the module off completely - it does NOT fall back to "no
      // exports declared" / the encapsulation-pattern default. Locking this
      // in as today's behavior; it may be worth a dedicated "no files
      // exported" diagnostic in the future, but that is a product decision,
      // not a bug fix in `exposes` itself.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
        exportedFilePatterns: [],
      });

      expect(module.exposes(fileAt('/project/mod/visible.ts'))).toBe(false);
    });
  });

  describe('exposes - foreign path guard', () => {
    it('never exposes a file outside the module, even when nothing about it would otherwise match the encapsulation pattern', () => {
      // Without this guard, a relative path leading out of the module
      // (`../other/internal/x.ts`) matches no encapsulation pattern and
      // would previously have been reported as publicly importable - a
      // fail-open hole. `other/internal/x.ts` isn't even under `internal/`
      // relative to `mod`, so the (fixed) pre-guard logic would have said
      // "exposed"; the guard now short-circuits to `false` before that
      // pattern check ever runs.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal',
        },
      });

      expect(module.exposes(fileAt('/project/other/internal/x.ts'))).toBe(
        false,
      );
    });
  });

  describe('exposes - path separator normalization', () => {
    it('normalizes a literal backslash in the relative path before matching a string pattern', () => {
      // We cannot force the real OS path separator to be `\` on this
      // (posix) test machine, but `normalizePathSeparators` does not care
      // *why* a path contains a backslash - it just replaces it. A file
      // whose own name embeds a literal `\` produces a relative path
      // containing that same backslash from `fs.relativeTo`, which is
      // enough to prove `exposes` normalizes before comparing: the pattern
      // below contains a forward slash and matches only once the
      // backslash has been normalized to `/`.
      const module = createModule({
        path: '/project/mod',
        hasBarrel: false,
        exposureConfig: {
          enableBarrelLess: true,
          encapsulationPattern: 'internal/deep',
        },
      });

      expect(module.exposes(fileAt('/project/mod/internal\\deep.ts'))).toBe(
        false,
      );
    });

    it('recognises its own barrel file when module path and file path disagree on the separator', () => {
      // `barrelPath` is built with `Fs.join` (= `path.join`), which on
      // Windows emits `\`, while `fileInfo.path` is tsconfig-derived and
      // uses `/`. The codebase acknowledges this mix explicitly in
      // `create-modules.ts` ("paths can mix separators (tsconfig-derived vs
      // fs-derived on Windows)"). Without normalising both sides, a barrel
      // module would not recognise its own barrel file and would report the
      // legal barrel import as an encapsulation violation.
      //
      // The real separator cannot be switched on this posix machine, so the
      // mix is reproduced by giving the module a path that itself contains a
      // backslash: `join` then yields `...\mod/index.ts` while the file is
      // addressed as `.../index.ts`.
      const fs = getFs();
      fs.writeFile('/project\\mod/index.ts', '');

      const module = new Module(
        toFsPath('/project\\mod'),
        new Map(),
        () => {
          throw new Error('getFileInfo should not be called by exposes()');
        },
        false,
        true,
        {
          barrelFile: 'index.ts',
          enableBarrelLess: false,
          encapsulationPattern: 'internal',
        },
      );

      expect(module.exposes(fileAt('/project/mod/index.ts'))).toBe(true);
    });
  });
});
