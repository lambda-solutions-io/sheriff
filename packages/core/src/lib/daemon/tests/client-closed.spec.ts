import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../client';

/**
 * Guards the daemon idle-shutdown hang: once the socket closes, the client
 * must expose `closed` and reject further requests instead of registering a
 * pending write on a destroyed socket that never settles.
 */
describe('DaemonClient closed state', () => {
  let server: net.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function connectedClient(): Promise<{
    client: DaemonClient;
    serverSocket: net.Socket;
  }> {
    return new Promise((resolve, reject) => {
      const listener = net.createServer();
      server = listener;
      let serverSocket: net.Socket | undefined;
      listener.on('connection', (socket) => {
        serverSocket = socket;
        maybeResolve();
      });
      listener.on('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (typeof address === 'string' || !address) {
          reject(new Error('no port'));
          return;
        }
        const socket = net.createConnection(address.port, '127.0.0.1');
        socket.once('connect', () => {
          clientSocket = socket;
          maybeResolve();
        });
        socket.once('error', reject);
      });

      let clientSocket: net.Socket | undefined;
      function maybeResolve() {
        if (clientSocket && serverSocket) {
          resolve({
            client: new DaemonClient(clientSocket),
            serverSocket,
          });
        }
      }
    });
  }

  it('reports not closed while the socket is live', async () => {
    const { client } = await connectedClient();
    expect(client.closed).toBe(false);
    client.close();
  });

  it('becomes closed when the socket emits close', async () => {
    const { client, serverSocket } = await connectedClient();

    serverSocket.destroy();

    await vi.waitFor(() => expect(client.closed).toBe(true));
  });

  it('rejects a request after the socket closes instead of hanging', async () => {
    const { client, serverSocket } = await connectedClient();

    serverSocket.destroy();
    await vi.waitFor(() => expect(client.closed).toBe(true));

    await expect(client.request('lintFile')).rejects.toThrow(
      'daemon connection closed',
    );
  });

  it('is closed and rejects after an explicit close()', async () => {
    const { client } = await connectedClient();

    client.close();

    expect(client.closed).toBe(true);
    await expect(client.request('lintFile')).rejects.toThrow(
      'daemon connection closed',
    );
  });
});
