import { readFileSync } from 'fs';
import { dirname, join } from 'path';

type PackageManifest = {
  bin?: {
    sheriff?: unknown;
  };
};

/**
 * Resolves the CLI belonging to the workspace's sheriff-core installation.
 * Starting from package.json keeps the bin path aligned with the installed
 * package version instead of assuming a node_modules directory layout.
 */
export function resolveCliBinPath(
  workspaceRoot: string,
  requireResolve?: (id: string) => string,
): string | undefined {
  const resolveFromWorkspace =
    requireResolve ??
    ((id: string): string =>
      require.resolve(id, {
        paths: [workspaceRoot],
      }));

  try {
    const manifestPath = resolveFromWorkspace(
      '@lambda-solutions/sheriff-core/package.json',
    );
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf-8'),
    ) as PackageManifest;
    const sheriffBin = manifest.bin?.sheriff;

    return typeof sheriffBin === 'string'
      ? join(dirname(manifestPath), sheriffBin)
      : undefined;
  } catch {
    return undefined;
  }
}
