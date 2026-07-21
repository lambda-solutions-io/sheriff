import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { nativeBinaryName, nativeTriple } = require('../platform.js');
const workspaceRoot = resolve(import.meta.dirname, '../../..');
const engineSource = join(workspaceRoot, 'packages/sheriff-engine');

it('runs the compiled verify CLI through the installed engine without fallback', () => {
  const tempRoot = mkdtempSync('/private/tmp/sheriff-engine-built-cli-');
  const triple = nativeTriple();
  const nativeSource = join(engineSource, 'native', nativeBinaryName());

  try {
    expect(
      existsSync(nativeSource),
      'build the native engine before running this integration test',
    ).toBe(true);

    execFileSync('npx', ['nx', 'build', 'core'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        NX_CACHE_DIRECTORY: join(tempRoot, 'nx-cache'),
        NX_DAEMON: 'false',
        NX_WORKSPACE_DATA_DIRECTORY: join(tempRoot, 'nx-workspace-data'),
      },
      stdio: 'pipe',
    });

    const builtCoreSource = join(workspaceRoot, 'dist/packages/core');
    const corePackage = readJson(join(builtCoreSource, 'package.json'));
    const enginePackage = readJson(join(engineSource, 'package.json'));
    expect(corePackage.optionalDependencies).toEqual({
      '@lambda-solutions/sheriff-engine': enginePackage.version,
    });

    const coreInstall = join(
      tempRoot,
      'node_modules/@lambda-solutions/sheriff-core',
    );
    cpSync(builtCoreSource, coreInstall, { recursive: true });

    const engineInstall = join(
      coreInstall,
      'node_modules/@lambda-solutions/sheriff-engine',
    );
    copyEnginePackage(engineInstall);

    const platformInstall = join(
      engineInstall,
      'node_modules/@lambda-solutions',
      `sheriff-engine-${triple}`,
    );
    cpSync(join(engineSource, 'npm', triple), platformInstall, {
      recursive: true,
    });
    cpSync(nativeSource, join(platformInstall, nativeBinaryName()));

    const platformPackage = readJson(join(platformInstall, 'package.json'));
    expect(enginePackage.optionalDependencies[platformPackage.name]).toBe(
      enginePackage.version,
    );

    const cliPath = join(coreInstall, 'src/bin/main.js');
    const result = spawnSync(process.execPath, [cliPath, 'verify'], {
      cwd: join(workspaceRoot, 'test-projects/angular-v-multi'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NAPI_RS_ENFORCE_VERSION_CHECK: '1',
        NODE_PATH: [join(workspaceRoot, 'node_modules'), process.env.NODE_PATH]
          .filter(Boolean)
          .join(delimiter),
        SHERIFF_ENGINE: '1',
        SHERIFF_ENGINE_DEBUG: '1',
      },
    });

    expect(
      result.status,
      `compiled CLI failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain('No issues found');
    expect(result.stderr).not.toContain(
      '[sheriff-engine] Falling back to TypeScript',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function copyEnginePackage(destination) {
  mkdirSync(join(destination, 'native'), { recursive: true });
  for (const file of [
    'README.md',
    'index.d.ts',
    'index.js',
    'package.json',
    'platform.js',
  ]) {
    cpSync(join(engineSource, file), join(destination, file));
  }
  for (const file of ['binding.d.ts', 'binding.js']) {
    cpSync(
      join(engineSource, 'native', file),
      join(destination, 'native', file),
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
