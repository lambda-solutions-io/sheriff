import {
  DaemonClient,
  isDaemonTransportError,
} from '@lambda-solutions/sheriff-core';

/** Minimal daemon client contract used by the MCP bridge. */
export interface SheriffDaemonClient {
  request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
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
let exitHandlersRegistered = false;

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
  cliBinPath: string | undefined,
  dependencies: DaemonBridgeDependencies,
): Promise<SheriffDaemonClient | undefined> {
  const existing = sharedConnections.get(rootDir);
  if (existing) {
    return existing.client;
  }

  let pending = pendingConnects.get(rootDir);
  if (!pending) {
    pending = dependencies
      .connect(rootDir, { spawnIfMissing: true, cliBinPath })
      .then((client) => {
        if (client) {
          sharedConnections.set(rootDir, { rootDir, client });
          registerExitHandlers();
        }
        return client;
      })
      .finally(() => {
        pendingConnects.delete(rootDir);
      });
    pendingConnects.set(rootDir, pending);
  }

  return pending;
}

/**
 * Closes and clears the cached connection for one root, so the next call
 * for that root reconnects. Other roots keep their connections.
 */
function closeSharedConnection(rootDir: string): void {
  const connection = sharedConnections.get(rootDir);
  if (!connection) {
    return;
  }
  sharedConnections.delete(rootDir);
  try {
    connection.client.close();
  } catch {
    // Ignore close failures during cleanup.
  }
}

/** Closes every cached connection. */
function closeAllSharedConnections(): void {
  for (const rootDir of [...sharedConnections.keys()]) {
    closeSharedConnection(rootDir);
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
}

/** Calls one daemon RPC and translates connection and request failures. */
export async function callDaemon(
  rootDir: string,
  cliBinPath: string | undefined,
  method: string,
  params?: Record<string, unknown>,
  dependencies: DaemonBridgeDependencies = defaultDependencies,
): Promise<DaemonCallResult> {
  let client: SheriffDaemonClient | undefined;
  try {
    client = await getSharedClient(rootDir, cliBinPath, dependencies);
  } catch (error) {
    closeSharedConnection(rootDir);
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
    return { success: true, value };
  } catch (error) {
    // Only a dead transport invalidates the connection. An error response
    // travels over a healthy socket and concerns just this request, so
    // tearing the connection down would fail every concurrent call with an
    // unrelated "daemon connection closed".
    if (isDaemonTransportError(error)) {
      closeSharedConnection(rootDir);
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
