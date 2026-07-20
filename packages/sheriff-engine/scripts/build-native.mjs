import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { nativeBinaryName } = require('../platform.js');

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const workspaceDir = path.resolve(packageDir, '..', '..');

const sourceNames = {
  darwin: 'libsheriff_engine.dylib',
  linux: 'libsheriff_engine.so',
  win32: 'sheriff_engine.dll',
};

const sourceName = sourceNames[process.platform];
if (!sourceName) {
  throw new Error(`Unsupported native platform: ${process.platform}`);
}

await new Promise((resolve, reject) => {
  const cargo = spawn(
    'cargo',
    ['build', '--release', '--offline', '-p', 'sheriff_engine'],
    {
      cwd: workspaceDir,
      env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
      stdio: 'inherit',
    },
  );

  cargo.once('error', reject);
  cargo.once('exit', (code, signal) => {
    if (code === 0) {
      resolve();
    } else {
      reject(
        new Error(
          `cargo build failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
        ),
      );
    }
  });
});

const nativeDir = path.join(packageDir, 'native');
// TODO(R5): publish native binaries through optional per-platform packages.
const targetName = nativeBinaryName();
await mkdir(nativeDir, { recursive: true });
await copyFile(
  path.join(workspaceDir, 'target', 'release', sourceName),
  path.join(nativeDir, targetName),
);

console.log(`Built native/${targetName}`);
