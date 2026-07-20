import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

describe('local LSP launcher', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    temporaryRoots.length = 0;
  });

  it('makes the built core package resolvable to the built server', () => {
    const root = mkdtempSync(join(tmpdir(), 'sheriff-lsp-launcher-test-'));
    temporaryRoots.push(root);
    const core = join(root, 'dist/packages/core');
    const server = join(root, 'dist/packages/lsp-server/src');
    mkdirSync(core, { recursive: true });
    mkdirSync(server, { recursive: true });
    writeFileSync(
      join(core, 'package.json'),
      JSON.stringify({ main: 'index.js', type: 'commonjs' }),
    );
    writeFileSync(join(core, 'index.js'), "exports.marker = 'core-resolved';");
    writeFileSync(
      join(server, 'main.js'),
      "process.stdout.write(require('@lambda-solutions/sheriff-core').marker);",
    );

    const result = spawnSync(
      process.execPath,
      [resolve('tools/scripts/run-lsp-local.mjs'), '--stdio'],
      {
        encoding: 'utf8',
        env: { ...process.env, SHERIFF_LSP_REPOSITORY_ROOT: root },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('core-resolved');
  });
});
