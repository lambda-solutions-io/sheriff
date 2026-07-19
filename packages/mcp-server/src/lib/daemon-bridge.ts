import { DaemonClient } from '@lambda-solutions/sheriff-core';

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
 * A single shared daemon connection, reused across tool calls to avoid
 * spawning competing daemons when the agent fires calls in parallel.
 */
interface SharedConnection {
  rootDir: string;
  client: SheriffDaemonClient;
}

let sharedConnection: SharedConnection | undefined;
let pendingConnect: Promise<SheriffDaemonClient | undefined> | undefined;
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
  if (sharedConnection && sharedConnection.rootDir === rootDir) {
    return sharedConnection.client;
  }

  // Root changed since the last connection; drop the stale one.
  if (sharedConnection && sharedConnection.rootDir !== rootDir) {
    closeSharedConnection();
  }

  if (!pendingConnect) {
    pendingConnect = dependencies
      .connect(rootDir, { spawnIfMissing: true, cliBinPath })
      .then((client) => {
        if (client) {
          sharedConnection = { rootDir, client };
          registerExitHandlers();
        }
        return client;
      })
      .finally(() => {
        pendingConnect = undefined;
      });
  }

  return pendingConnect;
}

/** Closes and clears the cached connection so the next call reconnects. */
function closeSharedConnection(): void {
  if (sharedConnection) {
    try {
      sharedConnection.client.close();
    } catch {
      // Ignore close failures during cleanup.
    }
    sharedConnection = undefined;
  }
}

function registerExitHandlers(): void {
  if (exitHandlersRegistered) {
    return;
  }
  exitHandlersRegistered = true;
  process.once('exit', closeSharedConnection);
}

/** Closes any shared connection. Exposed primarily for tests. */
export function resetDaemonConnection(): void {
  closeSharedConnection();
  pendingConnect = undefined;
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
    closeSharedConnection();
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
    // Drop the shared client on failure so the next call reconnects.
    closeSharedConnection();
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
