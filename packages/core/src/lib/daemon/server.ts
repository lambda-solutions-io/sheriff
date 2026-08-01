import * as net from 'net';
import * as fs from 'fs';
import { version as packageVersion } from '../../../package.json';
import { getDocumentLintAnalysis } from '../eslint/lint-document';
import { getPlugins } from '../cli/internal/get-plugins';
import { createPluginAPI } from '../plugin/create-plugin-api';
import { ProjectDataOptions } from '../plugin/plugin-api';
import { clearProjectCache } from '../cache/project-cache';
import { getDaemonSocketPath } from './socket-path';
import {
  createLineDecoder,
  DaemonRequest,
  DaemonResponse,
  encodeMessage,
  HandshakeResult,
} from './protocol';
import { startWatcher } from './watcher';

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

// generous on purpose: a slow daemon is still a live daemon
const SOCKET_PROBE_TIMEOUT_MS = 500;

export type DaemonServerOptions = {
  /** Project root; defaults to the current working directory. */
  rootDir?: string;
  /** Exit after this long without a request. */
  idleTimeoutMs?: number;
  log?: (message: string) => void;
  /** Ends the process on shutdown; replaceable for tests. */
  exit?: () => void;
};

export type DaemonServer = {
  socketPath: string;
  close: () => void;
};

/**
 * Long-running sheriff process. Serves verify/getProjectData/getConfig/
 * lintFile over a local socket while a filesystem watcher keeps the
 * project cache warm and exact. The process is disposable by design:
 * config changes and idle timeouts end it, and clients respawn it on
 * demand.
 */
export async function startDaemonServer(
  options: DaemonServerOptions = {},
): Promise<DaemonServer> {
  const rootDir = options.rootDir ?? process.cwd();
  const idleTimeoutMs = resolveIdleTimeout(options.idleTimeoutMs);
  const log = options.log ?? (() => void 0);
  const exit = options.exit ?? (() => process.exit(0));
  const socketPath = getDaemonSocketPath(rootDir);

  // never unlink a live daemon's socket: racing starts must fail here
  // (or in `listen` via EADDRINUSE) instead of hijacking the path
  await removeStaleSocket(socketPath);

  // shutdown may be requested before `listen` succeeds (config change, idle
  // timeout); the reason is remembered so the event is honoured rather than
  // lost once the server is up.
  let pendingShutdownReason: string | undefined;
  // set only by a pre-listen watcher error: unlike a config change or idle
  // timeout, a dead watcher means the daemon can never safely serve, so
  // startup must reject instead of resolving and shutting down right after
  let pendingWatcherError: Error | undefined;
  // assigned once listening, when the owned socket inode is known
  let releaseSocket: (() => void) | undefined;

  const releaseResources = () => {
    watcher.close();
    clearTimeout(idleTimer);
    // before `listen` there is no bound path to release: closing the
    // handle here would be a no-op at best and, once a successor owns
    // the path, a libuv unlink of its socket
    releaseSocket?.();
  };

  const shutdown = (reason: string) => {
    if (!releaseSocket) {
      pendingShutdownReason ??= reason;
      return;
    }
    log(`sheriff daemon shutting down: ${reason}`);
    releaseResources();
    // exit asynchronously so a pending response can flush first
    setTimeout(exit, 50).unref();
  };

  const idleTimer = setTimeout(() => shutdown('idle timeout'), idleTimeoutMs);
  idleTimer.unref();

  const watcher = startWatcher({
    rootDir,
    // the config is evaluated code; a fresh process is the only clean re-eval
    onConfigChange: () => shutdown('sheriff.config.ts changed'),
    onInvalidate: (file) => log(`invalidated ${file}`),
    // an unwatchable root (ENOSPC, EPERM, renamed/deleted root) leaves the
    // cache unable to stay exact; shut down cleanly instead of serving
    // stale results or crashing uncaught
    onError: (error) => {
      pendingWatcherError ??= error;
      shutdown(`filesystem watcher error: ${error.message}`);
    },
  });

  const server = net.createServer((socket) => {
    socket.setEncoding('utf-8');
    const connectionState: DaemonConnectionState = {};
    const decode = createLineDecoder((line) => {
      idleTimer.refresh();
      const response = handleRequestLine(
        line,
        rootDir,
        shutdown,
        connectionState,
      );
      socket.write(encodeMessage(response));
    });
    socket.on('data', decode);
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      // e.g. EADDRINUSE when another daemon won the startup race; the
      // watcher would pin the process and the timer keep firing. The
      // never-listening handle owns no path, so nothing to release.
      watcher.close();
      clearTimeout(idleTimer);
      reject(error);
    });
    server.listen(socketPath, () => {
      log(`sheriff daemon listening on ${socketPath} (pid ${process.pid})`);

      // identity of the socket file this daemon created; shutdown must
      // only ever unlink this exact file, never a successor daemon's
      const ownedSocketInode = getSocketInode(socketPath);

      releaseSocket = () => {
        // stat-then-close is a TOCTOU window: a successor could claim
        // the path in between. Unavoidable without an atomic
        // inode-checked unlink, and the window is a few microseconds.
        if (ownsSocketPath(socketPath, ownedSocketInode)) {
          // closing the handle also unlinks the socket file (libuv)
          server.close();
          removeOwnedSocket(socketPath, ownedSocketInode);
        } else {
          // the path belongs to a successor daemon now; closing the
          // handle would make libuv unlink the successor's socket, so
          // keep the nameless handle and let process exit reclaim it
          server.unref();
        }
      };

      // a watcher error pre-listen means the daemon could never safely
      // serve; fail startup outright instead of resolving and shutting
      // down right after, unlike a config change or idle timeout, which
      // are routine restarts and may resolve then replay below
      if (pendingWatcherError) {
        releaseResources();
        reject(pendingWatcherError);
        return;
      }

      resolve({
        socketPath,
        close: releaseResources,
      });

      if (pendingShutdownReason !== undefined) {
        shutdown(pendingShutdownReason);
      }
    });
  });
}

function handleRequestLine(
  line: string,
  rootDir: string,
  shutdown: (reason: string) => void,
  connectionState: DaemonConnectionState,
): DaemonResponse {
  let request: DaemonRequest;
  try {
    request = JSON.parse(line) as DaemonRequest;
  } catch {
    return { id: -1, error: { message: 'invalid request' } };
  }

  try {
    return {
      id: request.id,
      result: executeMethod(request, rootDir, shutdown, connectionState),
    };
  } catch (error) {
    return {
      id: request.id,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function executeMethod(
  request: DaemonRequest,
  rootDir: string,
  shutdown: (reason: string) => void,
  connectionState: DaemonConnectionState,
): unknown {
  const params = request.params ?? {};

  switch (request.method) {
    case 'handshake': {
      const clientVersion = params['coreVersion'];
      if (clientVersion !== packageVersion) {
        connectionState.clientVersion = asClientVersion(clientVersion);
        connectionState.handshakeCompatible = false;
        /*
         * Older `daemon status` clients only know the handshake request.
         * Keep that read-only probe from killing a healthy daemon, but
         * remember the skew on this socket so any follow-up work request is
         * rejected instead of serving data across incompatible core versions.
         */
        return createHandshakeResult(rootDir, false);
      }
      connectionState.clientVersion = packageVersion;
      connectionState.handshakeCompatible = true;
      return createHandshakeResult(rootDir, true);
    }
    case 'status':
      return createHandshakeResult(
        rootDir,
        params['coreVersion'] === packageVersion,
      );
    case 'shutdown': {
      shutdown('requested by client');
      return true;
    }
    case 'verify':
      ensureCompatibleWorkRequest(connectionState);
      return getPluginAPI(rootDir).verify(
        asOptionalString(params['entryFile']),
      );
    case 'getProjectData':
      ensureCompatibleWorkRequest(connectionState);
      return getPluginAPI(rootDir).getProjectData(
        asOptionalString(params['entryFile']),
        params['options'] as ProjectDataOptions | undefined,
      );
    case 'getConfig':
      ensureCompatibleWorkRequest(connectionState);
      // functions (depRules etc.) cannot cross the wire; strip them
      return JSON.parse(JSON.stringify(getPluginAPI(rootDir).getConfig()));
    case 'lintFile':
      ensureCompatibleWorkRequest(connectionState);
      return lintFile(
        String(params['filename']),
        asOptionalString(params['fileContent']),
      );
    case 'clearCache':
      ensureCompatibleWorkRequest(connectionState);
      clearProjectCache();
      return true;
    default:
      throw new Error(`unknown method ${request.method}`);
  }
}

type DaemonConnectionState = {
  clientVersion?: string;
  handshakeCompatible?: boolean;
};

function createHandshakeResult(
  rootDir: string,
  compatible?: boolean,
): HandshakeResult {
  return {
    coreVersion: packageVersion,
    rootDir,
    pid: process.pid,
    ...(compatible === undefined ? {} : { compatible }),
  };
}

function ensureCompatibleWorkRequest(state: DaemonConnectionState): void {
  if (state.handshakeCompatible !== true) {
    throwVersionMismatchError(state.clientVersion ?? 'unknown');
  }
}

function asClientVersion(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}

function throwVersionMismatchError(clientVersion: string): never {
  throw new Error(
    `sheriff daemon version mismatch: daemon ${packageVersion}, client ${clientVersion}`,
  );
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getPluginAPI(rootDir: string) {
  const { config } = getPlugins(rootDir);
  if (!config) {
    throw new Error('sheriff.config.ts not found');
  }
  return createPluginAPI(config, rootDir);
}

/**
 * Single-file lint identical to the checks the ESLint rules run.
 * `fileContent` carries unsaved editor buffers.
 */
function lintFile(filename: string, fileContent?: string) {
  const { result, configFileIsMissing } = getDocumentLintAnalysis(
    filename,
    fileContent,
    true,
  );

  if (configFileIsMissing) {
    return {
      dependencyRuleViolations: [],
      encapsulationViolations: [],
      externalRuleViolations: [],
      unresolvableImports: [],
    };
  }

  return {
    dependencyRuleViolations: result.dependencyRuleViolations.map(
      (violation) => ({
        fromTag: violation.fromTag,
        toTags: violation.toTags,
        rawImport: violation.rawImport,
      }),
    ),
    encapsulationViolations: Object.keys(result.encapsulationViolations),
    externalRuleViolations: result.externalRuleViolations.map((violation) => ({
      fromTag: violation.fromTag,
      externalLibrary: violation.externalLibrary,
    })),
    // Mirror the in-process rules, which report unresolvable relative imports
    // (e.g. a typo'd './foo') that the resolved-import checks never surface.
    unresolvableImports: result.unresolvableImports,
  };
}

/**
 * Removes a leftover socket file, but only after probing that no daemon
 * answers on it. Unlinking a live socket would orphan the daemon behind
 * it: still running and watching, yet unreachable and unkillable.
 */
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32' || !fs.existsSync(socketPath)) {
    return;
  }
  switch (await probeSocket(socketPath)) {
    case 'live':
      throw new Error(`sheriff daemon already listening on ${socketPath}`);
    case 'unreadable':
      throw new Error(
        `cannot probe the sheriff daemon socket at ${socketPath} ` +
          `(permission denied); remove it manually`,
      );
    case 'stale':
      break;
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    try {
      // an empty directory can squat on the path too
      fs.rmdirSync(socketPath);
    } catch {
      // already removed by another process, or non-removable: the
      // latter surfaces as EADDRINUSE from `listen`
    }
  }
}

type SocketProbeResult = 'live' | 'stale' | 'unreadable';

/** Connect-probe: only a provably dead path counts as stale. */
function probeSocket(socketPath: string): Promise<SocketProbeResult> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      // no answer is not proof of death; err on the side of the daemon
      probe.destroy();
      resolve('live');
    }, SOCKET_PROBE_TIMEOUT_MS);
    probe.once('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve('live');
    });
    probe.once('error', (error) => {
      clearTimeout(timer);
      switch ((error as NodeJS.ErrnoException).code) {
        // dead socket, vanished path, or a non-socket squatting on the
        // path: nothing can be listening, so removal is safe
        case 'ECONNREFUSED':
        case 'ENOENT':
        case 'ENOTSOCK':
        case 'EISDIR':
          resolve('stale');
          return;
        // unreadable: could hide a live daemon, but self-healing by
        // unlink is impossible either way; report instead of wedging
        // startup with a misleading "already listening"
        case 'EACCES':
        case 'EPERM':
          resolve('unreadable');
          return;
        default:
          resolve('live');
      }
    });
  });
}

function getSocketInode(socketPath: string): number | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  try {
    return fs.statSync(socketPath).ino;
  } catch {
    return undefined;
  }
}

/**
 * True while the file at the path is still the one this daemon created.
 * Windows named pipes vanish with their server and cannot be hijacked,
 * so ownership always holds there.
 */
function ownsSocketPath(
  socketPath: string,
  ownedSocketInode: number | undefined,
): boolean {
  if (process.platform === 'win32') {
    return true;
  }
  try {
    return fs.statSync(socketPath).ino === ownedSocketInode;
  } catch {
    return false;
  }
}

/**
 * Unlinks the socket only while it is still the file this daemon
 * created; a successor daemon's socket at the same path is left alone.
 */
function removeOwnedSocket(
  socketPath: string,
  ownedSocketInode: number | undefined,
): void {
  if (process.platform === 'win32' || ownedSocketInode === undefined) {
    return;
  }
  try {
    if (fs.statSync(socketPath).ino !== ownedSocketInode) {
      return;
    }
    fs.unlinkSync(socketPath);
  } catch {
    // another process may have removed it already
  }
}

function resolveIdleTimeout(idleTimeoutMs: number | undefined): number {
  const override = Number(process.env['SHERIFF_DAEMON_IDLE_MS']);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
}
