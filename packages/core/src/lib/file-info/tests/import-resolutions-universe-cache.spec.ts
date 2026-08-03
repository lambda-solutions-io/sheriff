import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDefaultFs, useVirtualFs } from '../../fs/getFs';
import { clearProjectCache } from '../../cache/project-cache';
import { init } from '../../main/init';
import { toFsPath } from '../fs-path';
import { tsConfig } from '../../test/fixtures/ts-config';

/**
 * Issue #49 follow-up: the import-resolutions cache entry stamped only the
 * entry file and the tsconfig chain, but `resolveImports` also consults
 * the nearest package.json (dependency universe) to classify unresolved
 * bare imports as external vs unresolvable. Without the manifest in the
 * dependency list, a long-lived process (daemon/LSP) served stale
 * classifications after a dependency was installed or removed.
 *
 * The scenario needs the real filesystem: on the `VirtualFs` ANY write
 * bumps the global write clock which already invalidates every
 * structure-dependent entry, masking the missing stamp. On the
 * `DefaultFs` freshness rests on the TTL plus the mtime stamps — the TTL
 * is pinned high (same convention as verify-multi-entry-cache.spec.ts),
 * so only a stamped dependency can invalidate, exactly like a long-lived
 * process between watcher events.
 */
describe('import resolutions cache and the dependency universe', () => {
  // scoped name so no ancestor node_modules of the tmp dir can resolve it
  const packageName = '@sheriff-test/universe-probe';
  let projectDir: string;

  beforeEach(() => {
    vi.stubEnv('SHERIFF_CACHE_TTL', String(60 * 60 * 1000));
    useDefaultFs();
    clearProjectCache();

    // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var)
    projectDir = nodeFs.realpathSync(
      nodeFs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-universe-')),
    );
    nodeFs.writeFileSync(path.join(projectDir, 'tsconfig.json'), tsConfig());
    nodeFs.mkdirSync(path.join(projectDir, 'src'));
    nodeFs.writeFileSync(
      path.join(projectDir, 'src', 'main.ts'),
      `import '${packageName}';`,
    );
  });

  afterEach(() => {
    clearProjectCache();
    vi.unstubAllEnvs();
    nodeFs.rmSync(projectDir, { recursive: true, force: true });
    useVirtualFs();
  });

  const writeManifest = (dependencies: Record<string, string>) => {
    const manifestPath = path.join(projectDir, 'package.json');
    nodeFs.writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'universe-test', dependencies }),
    );
    return manifestPath;
  };

  // both writes can land within the mtime granularity of the filesystem;
  // a forced bump keeps the "dependency changed" signal deterministic
  const bumpMtime = (filePath: string) => {
    const bumped = new Date(nodeFs.statSync(filePath).mtimeMs + 2_000);
    nodeFs.utimesSync(filePath, bumped, bumped);
  };

  const classifyProbeImport = () => {
    const project = init(toFsPath(path.join(projectDir, 'src', 'main.ts')));
    const fileInfo = project.getFileInfo(
      toFsPath(path.join(projectDir, 'src', 'main.ts')),
    );
    return {
      unresolvable: fileInfo.unresolvableImports,
      external: [...fileInfo.getExternalLibraries()],
    };
  };

  it('should re-classify after the manifest declares a new dependency', () => {
    writeManifest({});

    expect(classifyProbeImport()).toEqual({
      unresolvable: [packageName],
      external: [],
    });

    bumpMtime(writeManifest({ [packageName]: '^1.0.0' }));

    expect(classifyProbeImport()).toEqual({
      unresolvable: [],
      external: [packageName],
    });
  });

  it('should re-classify after the manifest drops a dependency', () => {
    writeManifest({ [packageName]: '^1.0.0' });

    expect(classifyProbeImport()).toEqual({
      unresolvable: [],
      external: [packageName],
    });

    bumpMtime(writeManifest({}));

    expect(classifyProbeImport()).toEqual({
      unresolvable: [packageName],
      external: [],
    });
  });
});
