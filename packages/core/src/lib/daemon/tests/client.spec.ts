import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonClient,
  isDaemonRequestTimeoutError,
  isDaemonTransportError,
} from '../client';

// Only `spawn` is stubbed; the rest of child_process stays real so any
// other consumer in the import graph behaves normally.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

/**
 * Regression tests for the request timeout (issue #53): a daemon that
 * accepts the connection but never answers must not hang the caller
 * forever, and a response the client cannot correlate (id -1, emitted
 * by the server on a JSON parse failure) must not leave the request
 * pending indefinitely either. Also covers the multi-pending case: the
 * id:-1 heuristic must not misattribute the failure to an unrelated,
 * merely-slow request.
 */
describe('DaemonClient request timeout', () => {
  let socketPath: string;
  let server: net.Server | undefined;
  let previousTimeoutEnv: string | undefined;

  beforeEach(() => {
    socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-client-spec-')),
      'daemon.sock',
    );
    previousTimeoutEnv = process.env['SHERIFF_DAEMON_REQUEST_TIMEOUT_MS'];
    // Keep the tests fast; production default is much higher.
    process.env['SHERIFF_DAEMON_REQUEST_TIMEOUT_MS'] = '100';
  });

  afterEach(() => {
    server?.close();
    if (previousTimeoutEnv === undefined) {
      delete process.env['SHERIFF_DAEMON_REQUEST_TIMEOUT_MS'];
    } else {
      process.env['SHERIFF_DAEMON_REQUEST_TIMEOUT_MS'] = previousTimeoutEnv;
    }
  });

  function listen(handleConnection: (socket: net.Socket) => void) {
    return new Promise<net.Server>((resolve) => {
      const s = net.createServer(handleConnection);
      s.listen(socketPath, () => resolve(s));
    });
  }

  function connectClient(): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => resolve(new DaemonClient(socket)));
      socket.once('error', reject);
    });
  }

  it('rejects a request within the timeout when the daemon is wedged', async () => {
    // Accepts the connection (so the connect-level timeout never trips)
    // but never writes a response, simulating a stuck-but-alive daemon.
    server = await listen(() => void 0);

    const client = await connectClient();
    const start = Date.now();

    await expect(client.request('verify')).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(2000);

    client.close();
  });

  it('does not leak the pending entry after a timeout', async () => {
    server = await listen(() => void 0);
    const client = await connectClient();

    await expect(client.request('verify')).rejects.toThrow(/timed out/);
    // A second request must get its own fresh timeout rather than being
    // immediately resolved/rejected by stale state from the first.
    await expect(client.request('verify')).rejects.toThrow(/timed out/);

    client.close();
  });

  it('rejects the single pending request on an unparseable-request response', async () => {
    // Mirrors daemon/server.ts handleRequestLine, which replies with
    // `{ id: -1, error }` when it cannot JSON.parse the request line.
    server = await listen((socket) => {
      socket.on('data', () => {
        socket.write(
          `${JSON.stringify({ id: -1, error: { message: 'invalid request' } })}\n`,
        );
      });
    });

    const client = await connectClient();

    await expect(client.request('verify')).rejects.toThrow('invalid request');

    client.close();
  });

  it('does not misattribute an id:-1 response when multiple requests are pending', async () => {
    // Regression: with two requests in flight, an id:-1 response must
    // NOT be blamed on the oldest one — an earlier request may simply be
    // slow (e.g. a wedged handler), not the one that failed to parse.
    // The healthy id1 must resolve normally; only id2 times out on its
    // own. This is what the MCP bridge relies on when it shares one
    // connection across parallel calls.
    //
    // Line-buffer server-side (chunks can coalesce both writes into one
    // `data` event) so exactly one id:-1 is sent, correlated to the
    // second *line*, regardless of TCP chunking.
    let lineCount = 0;
    server = await listen((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString();
        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex >= 0) {
          buffered = buffered.slice(newlineIndex + 1);
          lineCount += 1;
          if (lineCount === 2) {
            // id2's line is treated as corrupt; the client has no id to
            // correlate it to.
            socket.write(
              `${JSON.stringify({ id: -1, error: { message: 'invalid request' } })}\n`,
            );
          }
          // id1 (lineCount === 1): never answered, simulating a wedged
          // handler.
          newlineIndex = buffered.indexOf('\n');
        }
      });
    });

    const client = await connectClient();

    const first = client.request('verify');
    const second = client.request('getConfig');
    // Attach both rejection handlers in the same microtask turn so
    // neither promise is ever momentarily unhandled while the other's
    // assertion is pending.
    const firstAssertion = expect(first).rejects.toThrow(/timed out/);
    const secondAssertion = expect(second).rejects.toThrow(/timed out/);

    await Promise.all([firstAssertion, secondAssertion]);
    await vi.waitFor(() => expect(lineCount).toBe(2));

    client.close();
  });

  it('rejects with a typed timeout error', async () => {
    // Typed so callers need not match on message text: the MCP bridge
    // counts consecutive timeouts to detect a wedged daemon, and must not
    // mistake an application error that merely says "timed out" for one.
    server = await listen(() => void 0);
    const client = await connectClient();

    const error = await client.request('verify').catch((reason) => reason);

    expect(isDaemonRequestTimeoutError(error)).toBe(true);
    // A timeout leaves the socket usable, so it must not read as fatal.
    expect(isDaemonTransportError(error)).toBe(false);

    client.close();
  });
});

/**
 * Core resolves the CLI it spawns the daemon from, so callers (the MCP
 * server, the ESLint plugin) need no knowledge of core's file layout and
 * no deep import into its internals.
 */
describe('DaemonClient spawn CLI resolution', () => {
  let rootDir: string;
  let previousBinPathEnv: string | undefined;

  beforeEach(() => {
    // An empty root has no daemon socket, so connect always takes the
    // spawn path.
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-spawn-spec-'));
    previousBinPathEnv = process.env['SHERIFF_CLI_BIN_PATH'];
    delete process.env['SHERIFF_CLI_BIN_PATH'];
  });

  afterEach(() => {
    if (previousBinPathEnv === undefined) {
      delete process.env['SHERIFF_CLI_BIN_PATH'];
    } else {
      process.env['SHERIFF_CLI_BIN_PATH'] = previousBinPathEnv;
    }
  });

  /** The mocked spawn, reset per test so call counts stay isolated. */
  function stubSpawn() {
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      on: () => void 0,
      unref: () => void 0,
    } as unknown as childProcess.ChildProcess);
    return spawnMock;
  }

  function spawnedScript(spawnMock: ReturnType<typeof stubSpawn>): string {
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    return args[0];
  }

  it('spawns core own CLI entry when no cliBinPath is given', async () => {
    const spawnSpy = stubSpawn();

    await DaemonClient.connect(rootDir, { spawnIfMissing: true });

    expect(spawnSpy).toHaveBeenCalled();
    // Resolved relative to client.ts (src/lib/daemon) and so lands on
    // core's own entry at src/bin/main.js.
    expect(spawnedScript(spawnSpy)).toBe(
      path.join(__dirname, '..', '..', '..', 'bin', 'main.js'),
    );
  });

  it('lets SHERIFF_CLI_BIN_PATH override the resolved default', async () => {
    process.env['SHERIFF_CLI_BIN_PATH'] = '/custom/sheriff-cli.js';
    const spawnSpy = stubSpawn();

    await DaemonClient.connect(rootDir, { spawnIfMissing: true });

    expect(spawnedScript(spawnSpy)).toBe('/custom/sheriff-cli.js');
  });

  it('prefers an explicit cliBinPath over the environment and the default', async () => {
    process.env['SHERIFF_CLI_BIN_PATH'] = '/custom/sheriff-cli.js';
    const spawnSpy = stubSpawn();

    await DaemonClient.connect(rootDir, {
      spawnIfMissing: true,
      cliBinPath: '/explicit/sheriff-cli.js',
    });

    expect(spawnedScript(spawnSpy)).toBe('/explicit/sheriff-cli.js');
  });

  it('never spawns without spawnIfMissing', async () => {
    // The ESLint plugin worker connects this way and must stay
    // spawn-free even though core could now resolve a CLI itself.
    const spawnSpy = stubSpawn();

    await DaemonClient.connect(rootDir, { throwOnVersionMismatch: true });

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

/**
 * A connection can die while no request is in flight (the daemon exits, the
 * socket errors). The resulting 'error'/'close' rejects an empty pending
 * map, so nothing is left to settle a later request. Node compounds this by
 * reporting a write on a destroyed socket only to the write callback, never
 * as a second 'error' event, so an unguarded request never settles at all.
 */
describe('DaemonClient on a dead socket', () => {
  it('should reject a request made after the socket died while idle', async () => {
    const socket = new net.Socket();
    const client = new DaemonClient(socket);

    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.destroy();
    await closed;

    const error = await client.request('getConfig').catch((reason) => reason);

    expect(isDaemonTransportError(error)).toBe(true);
    expect((error as Error).message).toContain('daemon connection closed');
  });

  it('should reject when the write fails on an already dead socket', async () => {
    const socket = new net.Socket();
    const client = new DaemonClient(socket);
    // A socket that is not destroyed but cannot be written to: the guard
    // does not catch this, so the write callback has to settle the request.
    socket.write = ((_chunk: string, callback?: (error?: Error) => void) => {
      callback?.(new Error('EPIPE'));
      return false;
    }) as typeof socket.write;

    const error = await client.request('getConfig').catch((reason) => reason);

    expect(isDaemonTransportError(error)).toBe(true);
    expect((error as Error).message).toContain('EPIPE');
    socket.destroy();
  });
});
