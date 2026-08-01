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
 * handshake that daemon and client run the same sheriff version. A
 * mismatched daemon stays alive for its own clients, so `connect`
 * refuses the socket instead of spawning over it.
 */
export class DaemonClient {
  #socket: net.Socket;
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
    socket.on('error', (error) => this.#rejectAllPending(error));
    socket.on('close', () =>
      this.#rejectAllPending(new Error('daemon connection closed')),
    );
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
      await requestCompatibleHandshake(client);
      return client;
    } catch (error) {
      client.close();
      if (error instanceof DaemonVersionMismatchError) {
        return undefined;
      }
      if (options.spawnIfMissing && options.cliBinPath) {
        await delay(SPAWN_RETRY_DELAY_MS);
        spawnDaemon(rootDir, options.cliBinPath);
        const freshClient = await waitForDaemon(socketPath);
        if (!freshClient) {
          return undefined;
        }
        try {
          await requestCompatibleHandshake(freshClient);
          return freshClient;
        } catch (error) {
          freshClient.close();
          if (error instanceof DaemonVersionMismatchError) {
            return undefined;
          }
        }
      }
      return undefined;
    }
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeMessage({ id, method, params }));
    });
  }

  close(): void {
    this.#socket.destroy();
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
  const client = await connectToSocket(getDaemonSocketPath(rootDir));
  if (!client) {
    return undefined;
  }
  try {
    return (await client.request('status', {
      coreVersion: packageVersion,
    })) as HandshakeResult;
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

async function requestCompatibleHandshake(client: DaemonClient): Promise<void> {
  const handshake = (await client.request('handshake', {
    coreVersion: packageVersion,
  })) as HandshakeResult;

  if (handshake.compatible === false) {
    throw new DaemonVersionMismatchError(
      `sheriff daemon version mismatch: daemon ${handshake.coreVersion}, client ${packageVersion}`,
    );
  }
}

class DaemonVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonVersionMismatchError';
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
    await client.request('shutdown', { coreVersion: packageVersion });
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
