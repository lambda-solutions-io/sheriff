import * as net from 'net';
import * as path from 'path';
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
// The first request after spawnDaemon can be a cold full-graph build; a
// too-low default here would false-positive-timeout, and callDaemon's
// close-on-failure would then respawn into another cold build.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Marks a rejection caused by the transport itself (socket error or
 * close) rather than by an error response from a healthy daemon.
 * Callers sharing one connection across parallel requests use this to
 * decide whether the connection must be torn down: an error *response*
 * only concerns its own request, a dead socket concerns all of them.
 */
export class DaemonTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DaemonTransportError';
  }
}

/** True for failures that make the whole connection unusable. */
export function isDaemonTransportError(
  error: unknown,
): error is DaemonTransportError {
  return error instanceof DaemonTransportError;
}

/**
 * A request the daemon never answered in time. Deliberately not a
 * transport error: the socket stays usable, and with requests multiplexed
 * over one connection a single slow request must not fail the others.
 * Callers can still treat repeated timeouts as a wedged daemon.
 */
export class DaemonRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonRequestTimeoutError';
  }
}

/** True when a request timed out rather than failing outright. */
export function isDaemonRequestTimeoutError(
  error: unknown,
): error is DaemonRequestTimeoutError {
  return error instanceof DaemonRequestTimeoutError;
}

export type DaemonClientOptions = {
  /** Spawn a daemon when none is reachable. */
  spawnIfMissing?: boolean;
  /**
   * Throw instead of returning undefined when a daemon has a different core
   * version.
   */
  throwOnVersionMismatch?: boolean;
  /**
   * Script the daemon is spawned from, i.e. the sheriff CLI entry.
   * Optional: when omitted, core resolves its own CLI entry relative to
   * this module, so callers need no knowledge of core's layout. The
   * `SHERIFF_CLI_BIN_PATH` environment variable overrides that default.
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
  // An id:-1 parse-failure response (see #handleResponseLine) is only
  // attributed to a specific entry when exactly one request is pending;
  // otherwise it's a no-op and each request falls back to its own timeout.
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  /** Use `DaemonClient.connect` instead of constructing directly. */
  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding('utf-8');
    const decode = createLineDecoder((line) => this.#handleResponseLine(line));
    socket.on('data', decode);
    socket.on('error', (error) =>
      this.#rejectAllPending(
        new DaemonTransportError(error.message, { cause: error }),
      ),
    );
    socket.on('close', () =>
      this.#rejectAllPending(
        new DaemonTransportError('daemon connection closed'),
      ),
    );
  }

  static async connect(
    rootDir: string,
    options: DaemonClientOptions = {},
  ): Promise<DaemonClient | undefined> {
    const socketPath = getDaemonSocketPath(rootDir);

    let client = await connectToSocket(socketPath);
    // Deliberate behaviour change: spawning is gated on `spawnIfMissing`
    // alone. Previously a caller asking to spawn without a `cliBinPath`
    // silently did nothing; core now falls back to its own CLI entry.
    // Callers that must never spawn simply leave `spawnIfMissing` unset.
    if (!client && options.spawnIfMissing) {
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
        if (options.throwOnVersionMismatch) {
          throw error;
        }
        return undefined;
      }
      if (options.spawnIfMissing) {
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
            if (options.throwOnVersionMismatch) {
              throw error;
            }
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
    const timeoutMs = resolveRequestTimeout();
    return new Promise((resolve, reject) => {
      // A socket that died while idle has already emitted its single
      // 'error'/'close' with nothing pending, so no listener remains to
      // settle this promise. Node also swallows a write on a destroyed
      // socket (it only reports ERR_STREAM_DESTROYED to the write
      // callback), so without this guard the request would hang forever.
      if (this.#socket.destroyed) {
        reject(new DaemonTransportError('daemon connection closed'));
        return;
      }

      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new DaemonRequestTimeoutError(
            `daemon request '${method}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref();

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      this.#socket.write(encodeMessage({ id, method, params }), (error) => {
        if (error) {
          const pending = this.#pending.get(id);
          if (!pending) {
            return;
          }
          this.#pending.delete(id);
          pending.reject(
            new DaemonTransportError(error.message, { cause: error }),
          );
        }
      });
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

    // The server could not parse the request line and has no id to
    // correlate (daemon/server.ts handleRequestLine). We can only safely
    // attribute this to "the" pending request when there is exactly one:
    // with several in flight (e.g. the MCP bridge sharing one connection
    // across parallel calls), an earlier request may simply be slow
    // rather than missing, and blaming the oldest would reject a healthy
    // request while the actually-broken one hangs to its own timeout.
    if (response.id === -1) {
      if (this.#pending.size === 1) {
        const [[onlyId, pending]] = this.#pending;
        this.#pending.delete(onlyId);
        pending.reject(new Error(response.error?.message ?? 'invalid request'));
      }
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
    const status = (await client.request('status', {
      coreVersion: packageVersion,
    })) as HandshakeResult;
    return normalizeDaemonStatus(status);
  } catch (error) {
    if (!isUnknownMethodError(error, 'status')) {
      return undefined;
    }
    try {
      const status = (await client.request('handshake', {
        coreVersion: packageVersion,
      })) as HandshakeResult;
      return normalizeDaemonStatus(status);
    } catch {
      return undefined;
    }
  } finally {
    client.close();
  }
}

async function requestCompatibleHandshake(client: DaemonClient): Promise<void> {
  const handshake = (await client.request('handshake', {
    coreVersion: packageVersion,
  })) as HandshakeResult;

  if (
    handshake.compatible === false ||
    handshake.coreVersion !== packageVersion
  ) {
    const daemonVersion = handshake.coreVersion ?? 'unknown';
    throw new DaemonVersionMismatchError(
      `sheriff daemon version mismatch: daemon ${daemonVersion}, client ${packageVersion}`,
      daemonVersion,
      packageVersion,
    );
  }
}

/**
 * A daemon is already running for this root but analyses with a different
 * core version. Carries both versions so callers can tell the user what to
 * align instead of reporting a generic "daemon unavailable".
 */
export class DaemonVersionMismatchError extends Error {
  readonly daemonVersion: string;
  readonly clientVersion: string;

  constructor(message: string, daemonVersion: string, clientVersion: string) {
    super(message);
    this.name = 'DaemonVersionMismatchError';
    this.daemonVersion = daemonVersion;
    this.clientVersion = clientVersion;
  }
}

/** True when a daemon refused the connection over a version mismatch. */
export function isDaemonVersionMismatchError(
  error: unknown,
): error is DaemonVersionMismatchError {
  return error instanceof DaemonVersionMismatchError;
}

function normalizeDaemonStatus(status: HandshakeResult): HandshakeResult {
  return {
    ...status,
    compatible: status.compatible ?? status.coreVersion === packageVersion,
  };
}

function isUnknownMethodError(error: unknown, method: string): boolean {
  return error instanceof Error && error.message === `unknown method ${method}`;
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

/**
 * Sheriff CLI entry used when the caller supplies none. Resolved relative
 * to this module, which holds in the published layout
 * (`<pkg>/src/lib/daemon/client.js` -> `<pkg>/src/bin/main.js`), the same
 * relative-path assumption `package.json` is already imported under.
 *
 * `SHERIFF_CLI_BIN_PATH` overrides it as an escape hatch for installs
 * where the CLI lives elsewhere.
 *
 * Deliberately computed on demand rather than at module load: in the
 * source tree only `main.ts` exists, so an eager constant would bake in a
 * path that does not resolve under vitest.
 */
function resolveDefaultCliBinPath(): string {
  const override = process.env['SHERIFF_CLI_BIN_PATH'];
  if (override) {
    return override;
  }
  return path.join(__dirname, '..', '..', 'bin', 'main.js');
}

function spawnDaemon(rootDir: string, cliBinPath?: string): void {
  const binPath = cliBinPath ?? resolveDefaultCliBinPath();
  const child = spawn(process.execPath, [binPath, 'daemon', 'run'], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
  });
  // Without this, a spawn failure (e.g. EMFILE, EAGAIN) is an uncaught
  // exception instead of a connect failure the caller can react to;
  // `waitForDaemon` simply keeps polling and times out on its own.
  child.on('error', () => void 0);
  child.unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRequestTimeout(): number {
  const override = Number(process.env['SHERIFF_DAEMON_REQUEST_TIMEOUT_MS']);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}
