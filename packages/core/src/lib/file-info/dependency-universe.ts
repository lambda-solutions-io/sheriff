import { FsPath } from './fs-path';

export function getDependencyUniverse(
  fileDir: FsPath,
  rootDir: FsPath,
): Set<string> {
  void fileDir;
  void rootDir;
  return new Set<string>();
}

export function extractPackageName(specifier: string): string {
  return specifier;
}
