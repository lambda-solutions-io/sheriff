import { ConfigImport } from '../../config/configuration';
import getFs from '../../fs/getFs';
import { ProjectInfo } from '../../main/init';
import { cli } from '../cli';

/**
 * Prints the header block for `sheriff list` and `sheriff verify`: the
 * path of the `sheriff.config.ts` in use (relative to the project root, so
 * the output is stable across machines) and — in verbose mode — the
 * provenance of every module the config loaded during evaluation.
 *
 * Does nothing when the project runs without a config file.
 */
export function logConfigDetails(
  projectInfo: ProjectInfo,
  verbose = false,
): void {
  if (!projectInfo.configFilePath) {
    return;
  }

  const configPath = getFs().relativeTo(
    projectInfo.rootDir,
    projectInfo.configFilePath,
  );
  cli.log(`Config: ${configPath}`);
  if (verbose) {
    logConfigImports(projectInfo.config.configImports);
  }
  cli.log('');
}

function logConfigImports(configImports: ConfigImport[]): void {
  cli.log('Config imports:');
  if (configImports.length === 0) {
    cli.log('  (none)');
    return;
  }

  for (const configImport of configImports) {
    cli.log(`  ${formatConfigImport(configImport)}`);
  }
}

/**
 * Formats one {@link ConfigImport} as `specifier → realPath`. Entries whose
 * resolved path differs from the real path are marked as symlinked — this is
 * what reveals which workspace build is actually running. Failed resolutions
 * show the resolution error instead.
 */
export function formatConfigImport(configImport: ConfigImport): string {
  if (configImport.error !== undefined) {
    return `${configImport.specifier} → failed to resolve: ${configImport.error}`;
  }

  if (configImport.resolvedPath !== configImport.realPath) {
    return `${configImport.specifier} → ${configImport.realPath} (symlinked from ${configImport.resolvedPath})`;
  }

  return `${configImport.specifier} → ${configImport.realPath}`;
}
