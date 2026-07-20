import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Fs } from './fs';
import {
  FsPath,
  toFsPath,
  toFsPathFromDirent,
} from '../file-info/fs-path';

export class DefaultFs extends Fs {
  override appendFile(filename: string, contents: string): void {
    fs.appendFileSync(filename, contents, { encoding: 'utf-8' });
  }

  writeFile = (filename: string, contents: string): void => {
    fs.writeFileSync(filename, contents);
  };

  readFile = (path: string): string =>
    fs.readFileSync(path, { encoding: 'utf-8' }).toString();

  override readDirectory(
    directory: FsPath,
    filter?: 'none' | 'directory',
  ): FsPath[] {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((child) => filter === 'none' || child.isDirectory())
      .map((child) => toFsPath(path.join(directory, child.name)));
  }

  removeDir = (path: string) => {
    fs.rmSync(path, { recursive: true });
  };

  createDir = (path: string) => {
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path, { recursive: true });
    }
  };

  override exists(path: string): path is FsPath {
    return fs.existsSync(path);
  }

  tmpdir = () => os.tmpdir();

  cwd = () => process.cwd();

  override findFiles = (
    directory: FsPath,
    filename: string,
    found: FsPath[] = [],
    referencePath = '',
  ): FsPath[] => {
    const files = fs.readdirSync(directory, { withFileTypes: true });
    referencePath = referencePath || directory;

    for (const file of files) {
      const joinedPath = path.join(directory, file.name);
      // Dirent does not follow symlinks. Keep validating them so an uncached
      // broken symlink still throws, as it did when every entry used toFsPath.
      const filePath = file.isSymbolicLink()
        ? toFsPath(joinedPath)
        : toFsPathFromDirent(joinedPath);
      if (file.isFile() && file.name.toLowerCase() === filename.toLowerCase()) {
        found.push(filePath);
      }
      if (file.isDirectory()) {
        this.findFiles(filePath, filename, found, referencePath);
      }
    }
    return found;
  };

  reset(): void {
    return void true;
  }

  findNearestParentFile = (referenceFile: FsPath, filename: string): FsPath => {
    let current = path.dirname(referenceFile);
    while (current) {
      const filePath = path.join(current, filename);
      if (
        fs.existsSync(filePath) &&
        fs.lstatSync(filePath).isFile() &&
        // existsSync follows filesystem case rules; realpath preserves the
        // previous exact filename match on case-insensitive filesystems.
        path.basename(fs.realpathSync.native(filePath)) === filename
      ) {
        return toFsPath(filePath);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    throw new Error(`cannot find ${filename} near ${referenceFile}`);
  };

  isAbsolute = (p: string) => path.isAbsolute(p);

  override split = (p: string) => p.split(path.sep);

  print = () => void true;

  override isFile(path: FsPath): boolean {
    return fs.lstatSync(path).isFile();
  }

  override realpath(p: string): string {
    try {
      return fs.realpathSync.native(p);
    } catch {
      // File may not exist (deleted/renamed); keep the caller's path so
      // the "does not exist" branch handles it instead of throwing here.
      return p;
    }
  }

  override lastModified(path: FsPath): number {
    return fs.statSync(path).mtimeMs;
  }
}

const defaultFs = new DefaultFs();
export default defaultFs;
