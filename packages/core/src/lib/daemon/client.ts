import * as net from 'net';
import { spawn } from 'child_process';
import { version as packageVersion } from '../../../package.json';
import { getDaemonSocketPath } from './socket-path';
import {
  createLineDecoder,
  DaemonResponse,
  encodeMessage,
  HandshakeResult,
} from './protocol';

const CONNECT_TIMEOUT_MS = 200;
const SPAWN_RETRY_DELAY_MS = 100;
const SPAWN_RETRIES = 30;

export type DaemonClientOptions = {
  /** Spawn a daemon when none is reachable. */
  spawnIfMissing?: boolean;
  /**
   * Script the daemon is spawned from, i.e. the sheriff CLI entry.
   * Required with `spawnIfMissing`.
   */
  cliBinPath?: string;
};

/**
 * Connection to a running sheriff daemon. `connect` verifies via
 * handshake that daemon and client run the same sheriff version; a
 * mismatched daemon shuts itself down and `connect` retries once so a
 * fresh daemon of the right version takes over.
 */
export class DaemonClient {
  #socket: net.Socket;
  #isConnected = true;
  #nextRequestId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  /** Use `DaemonClient.connect` instead of constructing directly. */
  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding('utf-8');
    const decode = createLineDecoder((line) => this.#handleResponseLine(line));
    socket.on('data', decode);
    socket.on('error', (error) => {
      this.#isConnected = false;
      this.#rejectAllPending(error);
    });
    socket.on('close', () => {
      this.#isConnected = false;
      this.#rejectAllPending(new Error('daemon connection closed'));
    });
  }

  static async connect(
    rootDir: string,
    options: DaemonClientOptions = {},
  ): Promise<DaemonClient | undefined> {
    const socketPath = getDaemonSocketPath(rootDir);

    let client = await connectToSocket(socketPath);
    if (!client && options.spawnIfMissing && options.cliBinPath) {
      spawnDaemon(rootDir, options.cliBinPath);
      client = await waitForDaemon(socketPath);
    }
    if (!client) {
      return undefined;
    }

    try {
      await client.request('handshake', { coreVersion: packageVersion });
      return client;
    } catch {
      // version mismatch: the daemon exits itself; spawn a fresh one
      client.close();
      if (options.spawnIfMissing && options.cliBinPath) {
        await delay(SPAWN_RETRY_DELAY_MS);
        spawnDaemon(rootDir, options.cliBinPath);
        const freshClient = await waitForDaemon(socketPath);
        if (!freshClient) {
          return undefined;
        }
        try {
          await freshClient.request('handshake', {
            coreVersion: packageVersion,
          });
          return freshClient;
        } catch {
          freshClient.close();
        }
      }
      return undefined;
    }
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.#isConnected) {
      return Promise.reject(new Error('daemon connection closed'));
    }

    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeMessage({ id, method, params }));
    });
  }

  close(): void {
    this.#isConnected = false;
    this.#socket.destroy();
  }

  /** Whether the underlying daemon socket is still usable. */
  get isConnected(): boolean {
    return this.#isConnected;
  }

  #handleResponseLine(line: string): void {
    let response: DaemonResponse;
    try {
      response = JSON.parse(line) as DaemonResponse;
    } catch {
      return;
    }

    const pending = this.#pending.get(response.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/** Handshake result of a running daemon, or undefined when none runs. */
export async function getDaemonStatus(
  rootDir: string,
): Promise<HandshakeResult | undefined> {
  const client = await DaemonClient.connect(rootDir);
  if (!client) {
    return undefined;
  }
  try {
    return (await client.request('handshake', {
      coreVersion: packageVersion,
    })) as HandshakeResult;
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

/** Returns true when a daemon was running and accepted the shutdown. */
export async function stopDaemon(rootDir: string): Promise<boolean> {
  const socketPath = getDaemonSocketPath(rootDir);
  const client = await connectToSocket(socketPath);
  if (!client) {
    return false;
  }
  try {
    await client.request('shutdown');
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

function connectToSocket(
  socketPath: string,
): Promise<DaemonClient | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const cancel = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(cancel);
      resolve(new DaemonClient(socket));
    });
    socket.once('error', () => {
      clearTimeout(cancel);
      resolve(undefined);
    });
  });
}

async function waitForDaemon(
  socketPath: string,
): Promise<DaemonClient | undefined> {
  for (let attempt = 0; attempt < SPAWN_RETRIES; attempt++) {
    await delay(SPAWN_RETRY_DELAY_MS);
    const client = await connectToSocket(socketPath);
    if (client) {
      return client;
    }
  }
  return undefined;
}

function spawnDaemon(rootDir: string, cliBinPath: string): void {
  spawn(process.execPath, [cliBinPath, 'daemon', 'run'], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
