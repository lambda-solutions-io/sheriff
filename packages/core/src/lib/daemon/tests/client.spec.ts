import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../client';

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
});
