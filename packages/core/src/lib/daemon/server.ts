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
 * version mismatches, config changes, and idle timeouts all end it, and
 * clients respawn it on demand.
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

  let shutdown: (reason: string) => void = () => void 0;

  const idleTimer = setTimeout(() => shutdown('idle timeout'), idleTimeoutMs);
  idleTimer.unref();

  const watcher = startWatcher({
    rootDir,
    // the config is evaluated code; a fresh process is the only clean re-eval
    onConfigChange: () => shutdown('sheriff.config.ts changed'),
    onInvalidate: (file) => log(`invalidated ${file}`),
  });

  const server = net.createServer((socket) => {
    socket.setEncoding('utf-8');
    const decode = createLineDecoder((line) => {
      idleTimer.refresh();
      const response = handleRequestLine(line, rootDir, shutdown);
      socket.write(encodeMessage(response));
    });
    socket.on('data', decode);
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      // e.g. EADDRINUSE when another daemon won the startup race
      watcher.close();
      clearTimeout(idleTimer);
      reject(error);
    });
    server.listen(socketPath, () => {
      log(`sheriff daemon listening on ${socketPath} (pid ${process.pid})`);

      // identity of the socket file this daemon created; shutdown must
      // only ever unlink this exact file, never a successor daemon's
      const ownedSocketInode = getSocketInode(socketPath);

      const releaseSocket = () => {
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

      shutdown = (reason: string) => {
        log(`sheriff daemon shutting down: ${reason}`);
        watcher.close();
        clearTimeout(idleTimer);
        releaseSocket();
        // exit asynchronously so a pending response can flush first
        setTimeout(exit, 50).unref();
      };

      resolve({
        socketPath,
        close: () => {
          watcher.close();
          clearTimeout(idleTimer);
          releaseSocket();
        },
      });
    });
  });
}

function handleRequestLine(
  line: string,
  rootDir: string,
  shutdown: (reason: string) => void,
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
      result: executeMethod(request, rootDir, shutdown),
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
): unknown {
  const params = request.params ?? {};

  switch (request.method) {
    case 'handshake': {
      const clientVersion = params['coreVersion'];
      if (clientVersion !== packageVersion) {
        // a stale daemon must never serve a newer client
        shutdown(
          `version mismatch (daemon ${packageVersion}, client ${String(clientVersion)})`,
        );
        throw new Error(
          `sheriff daemon version mismatch: daemon ${packageVersion}, client ${String(clientVersion)}`,
        );
      }
      return {
        coreVersion: packageVersion,
        rootDir,
        pid: process.pid,
      } satisfies HandshakeResult;
    }
    case 'verify':
      return getPluginAPI().verify(asOptionalString(params['entryFile']));
    case 'getProjectData':
      return getPluginAPI().getProjectData(
        asOptionalString(params['entryFile']),
        params['options'] as ProjectDataOptions | undefined,
      );
    case 'getConfig':
      // functions (depRules etc.) cannot cross the wire; strip them
      return JSON.parse(JSON.stringify(getPluginAPI().getConfig()));
    case 'lintFile':
      return lintFile(
        String(params['filename']),
        asOptionalString(params['fileContent']),
      );
    case 'clearCache':
      clearProjectCache();
      return true;
    case 'shutdown':
      shutdown('requested by client');
      return true;
    default:
      throw new Error(`unknown method ${request.method}`);
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getPluginAPI() {
  const { config } = getPlugins();
  if (!config) {
    throw new Error('sheriff.config.ts not found');
  }
  return createPluginAPI(config);
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
  if (await hasLiveListener(socketPath)) {
    throw new Error(`sheriff daemon already listening on ${socketPath}`);
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // another process may have removed it already
  }
}

/** Connect-probe: only a provably dead socket counts as stale. */
function hasLiveListener(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      // no answer is not proof of death; err on the side of the daemon
      probe.destroy();
      resolve(true);
    }, SOCKET_PROBE_TIMEOUT_MS);
    probe.once('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once('error', (error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      resolve(code !== 'ECONNREFUSED' && code !== 'ENOENT');
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
