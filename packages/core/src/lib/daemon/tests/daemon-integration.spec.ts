import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { version as packageVersion } from '../../../../package.json';
import { DaemonClient, getDaemonStatus, stopDaemon } from '../client';
import { DaemonServer, startDaemonServer } from '../server';
import { createLineDecoder, HandshakeResult, encodeMessage } from '../protocol';
import { getDaemonSocketPath } from '../socket-path';

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

  beforeEach(() => {
    exit.mockClear();
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
    expect(status?.coreVersion).toBe(packageVersion);
    expect(status?.compatible).toBe(true);
  });

  it('should report skewed status without shutting down the daemon', async () => {
    const client = await connectWithoutHandshake(rootDir);

    const status = (await client.request('status', {
      coreVersion: '0.0.0-other',
    })) as HandshakeResult;

    expect(status.coreVersion).toBe(packageVersion);
    expect(status.pid).toBe(process.pid);
    expect(status.compatible).toBe(false);
    client.close();

    expect(exit).not.toHaveBeenCalled();
    expect((await getDaemonStatus(rootDir))?.pid).toBe(process.pid);
  });

  it('should fall back to the old handshake probe when status is unknown', async () => {
    const fallbackRootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-daemon-status-fallback-'),
    );
    const socketPath = getDaemonSocketPath(fallbackRootDir);
    const fallbackServer = net.createServer((socket) => {
      socket.setEncoding('utf-8');
      const decode = createLineDecoder((line) => {
        const request = JSON.parse(line) as {
          id: number;
          method: string;
        };
        if (request.method === 'status') {
          socket.write(
            encodeMessage({
              id: request.id,
              error: { message: 'unknown method status' },
            }),
          );
          return;
        }
        socket.write(
          encodeMessage({
            id: request.id,
            result: {
              coreVersion: '0.0.0-old',
              rootDir: fallbackRootDir,
              pid: 123,
            },
          }),
        );
      });
      socket.on('data', decode);
    });

    try {
      await new Promise<void>((resolve) =>
        fallbackServer.listen(socketPath, resolve),
      );

      expect(await getDaemonStatus(fallbackRootDir)).toEqual({
        coreVersion: '0.0.0-old',
        rootDir: fallbackRootDir,
        pid: 123,
        compatible: false,
      });
      expect(await DaemonClient.connect(fallbackRootDir)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => fallbackServer.close(() => resolve()));
      fs.rmSync(fallbackRootDir, { recursive: true, force: true });
    }
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

  it('should reject unhandshaked work without shutting down the daemon', async () => {
    const client = await connectWithoutHandshake(rootDir);

    await expect(client.request('clearCache')).rejects.toThrow(
      'version mismatch',
    );
    client.close();

    expect(exit).not.toHaveBeenCalled();
    expect((await getDaemonStatus(rootDir))?.pid).toBe(process.pid);
  });

  it('should reject skewed work without shutting down the daemon', async () => {
    const client = await connectWithoutHandshake(rootDir);

    await client.request('handshake', { coreVersion: '0.0.0-other' });
    await expect(client.request('verify')).rejects.toThrow('version mismatch');
    client.close();

    expect(exit).not.toHaveBeenCalled();
    expect((await getDaemonStatus(rootDir))?.pid).toBe(process.pid);
  });

  it('should keep unknown method errors visible after a skewed handshake', async () => {
    const client = await connectWithoutHandshake(rootDir);

    await client.request('handshake', { coreVersion: '0.0.0-other' });
    await expect(client.request('nope')).rejects.toThrow(
      'unknown method nope',
    );
    client.close();

    expect(exit).not.toHaveBeenCalled();
    expect((await getDaemonStatus(rootDir))?.pid).toBe(process.pid);
  });

  it('should accept shutdown despite a skewed or missing client version', async () => {
    const skewedClient = await connectWithoutHandshake(rootDir);

    await expect(
      skewedClient.request('shutdown', { coreVersion: '0.0.0-other' }),
    ).resolves.toBe(true);
    skewedClient.close();

    await waitForStoppedDaemon(rootDir);
    await waitForExitCalls(exit, 1);

    server = await startDaemonServer({ rootDir, exit });
    exit.mockClear();

    const oldClient = await connectWithoutHandshake(rootDir);

    await expect(oldClient.request('shutdown')).resolves.toBe(true);
    oldClient.close();

    await waitForStoppedDaemon(rootDir);
    await waitForExitCalls(exit, 1);
  });

  it('should report no daemon after requested shutdown', async () => {
    server = await startDaemonServer({ rootDir, exit });
    exit.mockClear();

    expect(await stopDaemon(rootDir)).toBe(true);
    await waitForStoppedDaemon(rootDir);
    expect(await getDaemonStatus(rootDir)).toBeUndefined();
  });
});

async function waitForStoppedDaemon(rootDir: string): Promise<void> {
  await vi.waitFor(() =>
    expect(getDaemonStatus(rootDir)).resolves.toBeUndefined(),
  );
}

async function waitForExitCalls(
  exit: ReturnType<typeof vi.fn>,
  calls: number,
): Promise<void> {
  await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(calls));
}

function connectWithoutHandshake(rootDir: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getDaemonSocketPath(rootDir));
    socket.once('connect', () => resolve(new DaemonClient(socket)));
    socket.once('error', reject);
  });
}

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
