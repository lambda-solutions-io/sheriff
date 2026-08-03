import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import getFs, { useDefaultFs, useVirtualFs } from '../../fs/getFs';
import { Fs } from '../../fs/fs';
import { isFsPath, toFsPath, toFsPathFromDirent } from '../fs-path';
import {
  describe,
  beforeEach,
  beforeAll,
  afterEach,
  it,
  expect,
} from 'vitest';

describe('FsPath', () => {
  describe('VirtualFs', () => {
    let fs: Fs;
    beforeAll(() => {
      useVirtualFs();
      fs = getFs();
    });

    beforeEach(() => {
      fs.reset();
    });

    it('should fail if path is not absolute', () => {
      expect(() => toFsPath('index.ts')).toThrowError('not absolute');
    });

    it('should fail if path does not exist', () => {
      expect(() => toFsPath('/index.ts')).toThrowError(
        '/index.ts does not exist',
      );
    });

    it('should return false on check for relative path', () => {
      expect(isFsPath('index.ts')).toBe(false);
    });

    it('should return false on check for non-existing file', () => {
      expect(isFsPath('/index.ts')).toBe(false);
    });

    it('should stop treating a deleted file as valid', () => {
      fs.writeFile('/project/index.ts', '');
      expect(isFsPath('/project/index.ts')).toBe(true);

      fs.removeDir(toFsPath('/project'));

      expect(isFsPath('/project/index.ts')).toBe(false);
      expect(() => toFsPath('/project/index.ts')).toThrowError(
        '/project/index.ts does not exist',
      );
    });
  });

  describe('DefaultFs', () => {
    let temporaryDirectory: string;

    beforeEach(() => {
      useDefaultFs();
      temporaryDirectory = nodeFs.mkdtempSync(
        path.join(os.tmpdir(), 'sheriff-fs-path-'),
      );
    });

    afterEach(() => {
      nodeFs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    it('should also allow a directory', () => {
      const fs = getFs();
      expect(isFsPath(fs.join(__dirname, '../tests'))).toBe(true);
    });

    it('should stop treating a deleted file as valid', () => {
      const filePath = path.join(temporaryDirectory, 'index.ts');
      nodeFs.writeFileSync(filePath, '');
      expect(toFsPath(filePath)).toBe(filePath);

      nodeFs.rmSync(filePath);

      expect(isFsPath(filePath)).toBe(false);
      expect(() => toFsPath(filePath)).toThrowError(
        `${filePath} does not exist`,
      );
    });

    it('should stop treating a deleted dirent path as valid', () => {
      const filePath = path.join(temporaryDirectory, 'index.ts');
      nodeFs.writeFileSync(filePath, '');
      expect(toFsPathFromDirent(filePath)).toBe(filePath);

      nodeFs.rmSync(filePath);

      expect(isFsPath(filePath)).toBe(false);
    });
  });
});
