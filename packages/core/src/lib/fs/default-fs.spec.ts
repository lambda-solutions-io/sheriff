import defaultFs, { DefaultFs } from './default-fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toFsPath } from '../file-info/fs-path';
import { useDefaultFs } from './getFs';

describe('Default Fs', () => {
  const fs = new DefaultFs();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('find files', () => {
    it('should not check existence for directory entries', () => {
      useDefaultFs();
      const directory = toFsPath(path.join(__dirname, './find-files/test2'));
      const existsSpy = vi.spyOn(defaultFs, 'exists');

      const found = fs.findFiles(directory, 'index.ts');

      expect(found).toEqual([
        path.join(__dirname, 'find-files/test2', 'customers/index.ts'),
      ]);
      expect(existsSpy).not.toHaveBeenCalled();
    });

    it('should find the index.ts in project directory test1', () => {
      const found = fs.findFiles(
        toFsPath(path.join(__dirname, './find-files/test1')),
        'index.ts',
      );
      expect(found).toEqual([
        path.join(__dirname, 'find-files/test1/', 'index.ts'),
      ]);
    });

    it('should be case insensitive', () => {
      const found = fs.findFiles(
        toFsPath(path.join(__dirname, './find-files/test1')),
        'INDEX.ts',
      );
      expect(found).toEqual([
        path.join(__dirname, 'find-files/test1/', 'index.ts'),
      ]);
    });

    it('should find the index.ts in sub directory', () => {
      const found = fs.findFiles(
        toFsPath(path.join(__dirname, './find-files/test2')),
        'index.ts',
      );
      expect(found).toEqual([
        path.join(__dirname, 'find-files/test2', 'customers/index.ts'),
      ]);
    });

    it('should find multiple index.ts recursively', () => {
      const found = fs.findFiles(
        toFsPath(path.join(__dirname, './find-files/test3')),
        'index.ts',
      );
      expect(found).toEqual(
        [
          'admin/booking/data/index.ts',
          'admin/booking/feature/index.ts',
          'customers/index.ts',
          'holidays/index.ts',
        ].map((s) => path.join(__dirname, 'find-files/test3', s)),
      );
    });

    it('should find none if not in directory', () => {
      const found = fs.findFiles(
        toFsPath(path.join(__dirname, './find-files/test4')),
        'index.ts',
      );
      expect(found).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'should not follow symlinks',
      () => {
        const temporaryDirectory = nodeFs.mkdtempSync(
          path.join(os.tmpdir(), 'sheriff-find-files-'),
        );
        const searchDirectory = path.join(temporaryDirectory, 'search');
        const targetDirectory = path.join(temporaryDirectory, 'target');

        try {
          nodeFs.mkdirSync(searchDirectory);
          nodeFs.mkdirSync(targetDirectory);
          nodeFs.writeFileSync(path.join(temporaryDirectory, 'target.ts'), '');
          nodeFs.writeFileSync(path.join(targetDirectory, 'index.ts'), '');
          nodeFs.symlinkSync(
            path.join(temporaryDirectory, 'target.ts'),
            path.join(searchDirectory, 'index.ts'),
          );
          nodeFs.symlinkSync(
            targetDirectory,
            path.join(searchDirectory, 'linked-directory'),
          );

          expect(fs.findFiles(toFsPath(searchDirectory), 'index.ts')).toEqual(
            [],
          );
        } finally {
          nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should reject an uncached broken symlink',
      () => {
        const temporaryDirectory = nodeFs.mkdtempSync(
          path.join(os.tmpdir(), 'sheriff-find-files-'),
        );

        try {
          nodeFs.symlinkSync(
            path.join(temporaryDirectory, 'missing.ts'),
            path.join(temporaryDirectory, 'broken.ts'),
          );

          expect(() =>
            fs.findFiles(toFsPath(temporaryDirectory), 'index.ts'),
          ).toThrowError('broken.ts does not exist');
        } finally {
          nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
      },
    );
  });

  describe('findNearest', () => {
    it('should find in second parent', () => {
      const found = fs.findNearestParentFile(
        toFsPath(
          path.join(
            __dirname,
            './find-nearest/test1/customers/admin/core/feature/index.ts',
          ),
        ),
        'tsconfig.json',
      );
      expect(found).toBe(
        path.join(__dirname, './find-nearest/test1/customers/tsconfig.json'),
      );
    });

    it('should stop at the first parent', () => {
      const found = fs.findNearestParentFile(
        toFsPath(
          path.join(
            __dirname,
            './find-nearest/test2/customers/admin/core/feature/index.ts',
          ),
        ),
        'tsconfig.json',
      );
      expect(found).toBe(
        path.join(
          __dirname,
          './find-nearest/test2/customers/admin/core/tsconfig.json',
        ),
      );
    });

    it('should throw an error if not found', () => {
      expect(() =>
        fs.findNearestParentFile(
          toFsPath(
            path.join(
              __dirname,
              './find-nearest/test2/customers/admin/core/feature/index.ts',
            ),
          ),
          'a file that does not exist',
        ),
      ).toThrowError('cannot find a file that does not exist');
    });

    it('should match filenames case-sensitively', () => {
      expect(() =>
        fs.findNearestParentFile(
          toFsPath(
            path.join(
              __dirname,
              './find-nearest/test1/customers/admin/core/feature/index.ts',
            ),
          ),
          'TSCONFIG.JSON',
        ),
      ).toThrowError('cannot find TSCONFIG.JSON');
    });
  });

  it('should only find directories', () => {
    const subDirectories = fs.readDirectory(
      toFsPath(path.join(__dirname, './find-nearest/test1/customers')),
      'directory',
    );
    expect(subDirectories).toEqual(
      [path.join(__dirname, './find-nearest/test1/customers/admin')].map(
        toFsPath,
      ),
    );
  });
});
