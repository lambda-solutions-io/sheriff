import { FsPath } from '../file-info/fs-path';

/**
 * Resolves which config file governs `filePath`, given the root config's
 * `configs` field.
 *
 * The most specific (deepest) matching entry wins. Files which no entry covers
 * are governed by the root config, for which `undefined` is returned.
 *
 * @param filePath the file to resolve the config for
 * @param rootDir the workspace root
 * @param configs the root config's `configs` field
 *
 * TODO: not implemented yet — see task 4. This is a signature-only stub so
 * that the specs fail on their assertions instead of on a missing module.
 */
export const resolveConfigForFile = (
  _filePath: FsPath,
  _rootDir: FsPath,
  _configs: Record<string, string>,
): string | undefined => {
  return undefined;
};
