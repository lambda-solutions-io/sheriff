import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { version as packageVersion } from '../../../../package.json';
import { DaemonClient, getDaemonStatus, stopDaemon } from '../client';
import { DaemonServer, startDaemonServer } from '../server';
import { HandshakeResult } from '../protocol';

/**
 * End-to-end over a real socket against a minimal on-disk project:
 * `src/main.ts` imports `feature/index.ts`, which deep-imports into
 * `shared/internal.ts` — an encapsulation violation.
 */
describe('daemon integration', () => {
  let rootDir: string;
  let server: DaemonServer;
  let previousCwd: string;
  const exit = vi.fn();

  beforeAll(async () => {
    previousCwd = process.cwd();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-daemon-spec-'));

    writeFixtureProject(rootDir);
    process.chdir(rootDir);

    server = await startDaemonServer({ rootDir, exit });
  });

  afterAll(() => {
    process.chdir(previousCwd);
    server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('should complete a handshake for the matching version', async () => {
    const client = await DaemonClient.connect(rootDir);
    expect(client).toBeDefined();

    const handshake = (await client!.request('handshake', {
      coreVersion: packageVersion,
    })) as HandshakeResult;

    expect(handshake.coreVersion).toBe(packageVersion);
    expect(handshake.rootDir).toBe(rootDir);
    expect(handshake.pid).toBe(process.pid);
    client!.close();
  });

  it('should report the status', async () => {
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });

  it('should verify the project over the socket', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('verify')) as {
      success: boolean;
      encapsulationViolationCount: number;
    };

    expect(result.success).toBe(false);
    expect(result.encapsulationViolationCount).toBe(1);
    client!.close();
  });

  it('should return the config without functions', async () => {
    const client = await DaemonClient.connect(rootDir);

    const config = (await client!.request('getConfig')) as Record<
      string,
      unknown
    >;

    expect(config['entryFile']).toBe('src/main.ts');
    expect(JSON.stringify(config)).not.toContain('function');
    client!.close();
  });

  it('should lint a single file', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
    })) as { encapsulationViolations: string[] };

    expect(result.encapsulationViolations).toHaveLength(1);
    client!.close();
  });

  it('should lint unsaved content without touching the cache', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
      fileContent: 'export const clean = 1;',
    })) as { encapsulationViolations: string[] };

    expect(result.encapsulationViolations).toHaveLength(0);

    // the on-disk state must be unaffected by the unsaved buffer
    const onDisk = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
    })) as { encapsulationViolations: string[] };
    expect(onDisk.encapsulationViolations).toHaveLength(1);
    client!.close();
  });

  it('should surface unresolvable relative imports', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
      // a typo'd relative import the resolved-import checks never surface
      fileContent: "import { x } from './does-not-exist';\nexport const y = x;",
    })) as { unresolvableImports: string[] };

    expect(result.unresolvableImports).toContain('./does-not-exist');
    client!.close();
  });

  it('should reject unknown methods', async () => {
    const client = await DaemonClient.connect(rootDir);

    await expect(client!.request('nope')).rejects.toThrow(
      'unknown method nope',
    );
    client!.close();
  });

  it('should shut down on version mismatch', async () => {
    const client = await DaemonClient.connect(rootDir);

    await expect(
      client!.request('handshake', { coreVersion: '0.0.0-other' }),
    ).rejects.toThrow('version mismatch');
    client!.close();

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it('should report no daemon after shutdown', async () => {
    expect(await stopDaemon(rootDir)).toBe(false);
    expect(await getDaemonStatus(rootDir)).toBeUndefined();
  });
});

function writeFixtureProject(rootDir: string) {
  const write = (relativePath: string, contents: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  };

  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }),
  );
  write(
    'sheriff.config.ts',
    `export const config = {
  entryFile: 'src/main.ts',
  depRules: {
    root: ['root', 'noTag'],
    noTag: ['root', 'noTag'],
  },
};`,
  );
  write('src/main.ts', `import './feature';\n`);
  write(
    'src/feature/index.ts',
    `import { internal } from '../shared/internal';\nexport const feature = internal;\n`,
  );
  write('src/shared/index.ts', `export const shared = 1;\n`);
  write('src/shared/internal.ts', `export const internal = 2;\n`);
}
