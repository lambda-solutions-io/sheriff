#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const repositoryRoot =
  process.env['SHERIFF_LSP_REPOSITORY_ROOT'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverEntry = join(
  repositoryRoot,
  'dist/packages/lsp-server/src/main.js',
);
const corePackage = join(repositoryRoot, 'dist/packages/core');

for (const requiredPath of [serverEntry, corePackage]) {
  if (!existsSync(requiredPath)) {
    process.stderr.write(
      `Missing ${requiredPath}. Run "YARN_IGNORE_PATH=1 corepack yarn build:all" first.\n`,
    );
    process.exit(1);
  }
}

const runtimeRoot = mkdtempSync(join(tmpdir(), 'sheriff-lsp-local-'));
const scopedPackages = join(runtimeRoot, 'node_modules/@lambda-solutions');
mkdirSync(scopedPackages, { recursive: true });
symlinkSync(
  corePackage,
  join(scopedPackages, 'sheriff-core'),
  process.platform === 'win32' ? 'junction' : 'dir',
);

const nodePath = [join(runtimeRoot, 'node_modules'), process.env['NODE_PATH']]
  .filter(Boolean)
  .join(process.platform === 'win32' ? ';' : ':');
const server = spawn(
  process.execPath,
  [serverEntry, ...process.argv.slice(2)],
  {
    env: { ...process.env, NODE_PATH: nodePath },
    stdio: 'inherit',
  },
);

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  rmSync(runtimeRoot, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

server.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  cleanup();
  process.exitCode = 1;
});
server.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
