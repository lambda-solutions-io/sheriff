import * as path from 'path';
import {
  DaemonClient,
  isDaemonRequestTimeoutError,
  isDaemonTransportError,
} from '@lambda-solutions/sheriff-core';

/** Minimal daemon client contract used by the MCP bridge. */
export interface SheriffDaemonClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** Injectable daemon connector, primarily useful for testing tool calls. */
export interface DaemonBridgeDependencies {
  connect(
    rootDir: string,
    options: { spawnIfMissing?: boolean; cliBinPath?: string },
  ): Promise<SheriffDaemonClient | undefined>;
}

/** Result of invoking a Sheriff daemon RPC. */
export type DaemonCallResult =
  | { success: true; value: unknown }
  | { success: false; message: string };

const defaultDependencies: DaemonBridgeDependencies = {
  connect: (rootDir, options) => DaemonClient.connect(rootDir, options),
};

/**
 * A shared daemon connection for one root, reused across tool calls to
 * avoid spawning competing daemons when the agent fires calls in parallel.
 */
interface SharedConnection {
  rootDir: string;
  client: SheriffDaemonClient;
}

/**
 * One shared connection and one in-flight connect per root directory, so a
 * call for root B never receives the client belonging to root A.
 */
const sharedConnections = new Map<string, SharedConnection>();
const pendingConnects = new Map<
  string,
  Promise<SheriffDaemonClient | undefined>
>();
/** Consecutive timed-out requests per root; reset by any success. */
const consecutiveTimeouts = new Map<string, number>();
let exitHandlersRegistered = false;

/**
 * A single timeout is not fatal: with requests multiplexed over one
 * connection, one slow request is no proof the daemon is gone, and tearing
 * down would fail the healthy concurrent calls (the bug this guards).
 * Repeated timeouts in a row are different — they indicate a wedged daemon
 * that would otherwise stay cached forever, costing a full timeout on every
 * later call with no path to recovery.
 */
const MAX_CONSECUTIVE_TIMEOUTS = 3;

/**
 * Canonical cache key for a root, so `/foo` and `/foo/` do not each open
 * their own connection to the very same daemon.
 */
function toConnectionKey(rootDir: string): string {
  return path.resolve(rootDir);
}

/** Resolves the installed Sheriff CLI, with an environment variable fallback. */
export function resolveSheriffCliBinPath(): string | undefined {
  try {
    return require.resolve('@lambda-solutions/sheriff-core/src/bin/main.js');
  } catch {
    return process.env['SHERIFF_CLI_BIN_PATH'];
  }
}

/**
 * Returns the shared daemon client, connecting (and spawning if missing) once.
 * Concurrent first calls share one in-flight connect promise so only a single
 * daemon is ever spawned.
 */
async function getSharedClient(
  rootDir: string,
  connectionKey: string,
  cliBinPath: string | undefined,
  dependencies: DaemonBridgeDependencies,
): Promise<SheriffDaemonClient | undefined> {
  const existing = sharedConnections.get(connectionKey);
  if (existing) {
    return existing.client;
  }

  let pending = pendingConnects.get(connectionKey);
  if (!pending) {
    pending = dependencies
      .connect(rootDir, { spawnIfMissing: true, cliBinPath })
      .then((client) => {
        if (client) {
          sharedConnections.set(connectionKey, { rootDir, client });
          registerExitHandlers();
        }
        return client;
      })
      .finally(() => {
        pendingConnects.delete(connectionKey);
      });
    pendingConnects.set(connectionKey, pending);
  }

  return pending;
}

/**
 * Closes and clears the cached connection for one root, so the next call
 * for that root reconnects. Other roots keep their connections.
 */
function closeSharedConnection(connectionKey: string): void {
  consecutiveTimeouts.delete(connectionKey);
  const connection = sharedConnections.get(connectionKey);
  if (!connection) {
    return;
  }
  sharedConnections.delete(connectionKey);
  try {
    connection.client.close();
  } catch {
    // Ignore close failures during cleanup.
  }
}

/** Closes every cached connection. */
function closeAllSharedConnections(): void {
  for (const connectionKey of [...sharedConnections.keys()]) {
    closeSharedConnection(connectionKey);
  }
}

function registerExitHandlers(): void {
  if (exitHandlersRegistered) {
    return;
  }
  exitHandlersRegistered = true;
  process.once('exit', closeAllSharedConnections);
}

/** Closes all shared connections. Exposed primarily for tests. */
export function resetDaemonConnection(): void {
  closeAllSharedConnections();
  pendingConnects.clear();
  consecutiveTimeouts.clear();
}

/** Calls one daemon RPC and translates connection and request failures. */
export async function callDaemon(
  rootDir: string,
  cliBinPath: string | undefined,
  method: string,
  params?: Record<string, unknown>,
  dependencies: DaemonBridgeDependencies = defaultDependencies,
): Promise<DaemonCallResult> {
  const connectionKey = toConnectionKey(rootDir);
  let client: SheriffDaemonClient | undefined;
  try {
    client = await getSharedClient(
      rootDir,
      connectionKey,
      cliBinPath,
      dependencies,
    );
  } catch (error) {
    closeSharedConnection(connectionKey);
    return {
      success: false,
      message: `Sheriff daemon request failed: ${getErrorMessage(error)}`,
    };
  }

  if (!client) {
    return {
      success: false,
      message:
        `Sheriff daemon unavailable: could not connect or spawn a daemon for ${rootDir}. ` +
        'Ensure @lambda-solutions/sheriff-core is installed and a valid sheriff config exists.',
    };
  }

  try {
    const value = await requestDaemon(client, method, params);
    // The daemon answered, so it is not wedged.
    consecutiveTimeouts.delete(connectionKey);
    return { success: true, value };
  } catch (error) {
    // Only a dead transport invalidates the connection. An error response
    // travels over a healthy socket and concerns just this request, so
    // tearing the connection down would fail every concurrent call with an
    // unrelated "daemon connection closed".
    if (isDaemonTransportError(error)) {
      closeSharedConnection(connectionKey);
    } else if (isDaemonRequestTimeoutError(error)) {
      registerTimeout(connectionKey);
    } else {
      // A plain error response proves the daemon is still answering.
      consecutiveTimeouts.delete(connectionKey);
    }
    return {
      success: false,
      message: `Sheriff daemon request failed: ${getErrorMessage(error)}`,
    };
  }
}

function requestDaemon(
  client: SheriffDaemonClient,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  return params === undefined
    ? client.request(method)
    : client.request(method, params);
}

/**
 * Counts a timeout for one root and drops the connection once the daemon
 * has missed `MAX_CONSECUTIVE_TIMEOUTS` requests in a row, so a wedged
 * daemon is replaced instead of timing out every future call.
 */
function registerTimeout(connectionKey: string): void {
  const timeouts = (consecutiveTimeouts.get(connectionKey) ?? 0) + 1;
  if (timeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
    // Also clears the counter for this root.
    closeSharedConnection(connectionKey);
    return;
  }
  consecutiveTimeouts.set(connectionKey, timeouts);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
