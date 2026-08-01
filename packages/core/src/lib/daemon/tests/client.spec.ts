import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../client';

/**
 * Regression tests for the request timeout (issue #53): a daemon that
 * accepts the connection but never answers must not hang the caller
 * forever, and a response the client cannot correlate (id -1, emitted
 * by the server on a JSON parse failure) must not leave the request
 * pending indefinitely either.
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

  it('rejects the oldest pending request on an unparseable-request response', async () => {
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
});
