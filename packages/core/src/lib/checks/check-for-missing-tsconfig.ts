import { toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';

/**
 * Checks whether the `tsconfig.json` for an entry point can be found.
 *
 * Sheriff resolves the nearest `tsconfig.json` above the entry file and
 * uses its directory as the project root — without it, no analysis can
 * run for that entry point. Returns a human-readable reason when the
 * entry file itself is missing or no `tsconfig.json` exists above it,
 * and `undefined` when the entry point is fine.
 *
 * @param entryFile the entry file as given in the CLI or config,
 *   relative to the current working directory or absolute
 */
export function checkForMissingTsConfig(entryFile: string): string | undefined {
  const fs = getFs();
  const absoluteEntryFile = fs.isAbsolute(entryFile)
    ? entryFile
    : fs.join(fs.cwd(), entryFile);

  if (!fs.exists(absoluteEntryFile)) {
    return `entry file ${entryFile} does not exist`;
  }

  try {
    fs.findNearestParentFile(toFsPath(absoluteEntryFile), 'tsconfig.json');
    return undefined;
  } catch {
    return `no tsconfig.json found above ${entryFile}`;
  }
}
