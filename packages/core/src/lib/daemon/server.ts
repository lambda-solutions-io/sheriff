import * as net from 'net';
import * as fs from 'fs';
import { version as packageVersion } from '../../../package.json';
import { getDocumentLintAnalysis } from '../eslint/lint-document';
import { getPlugins } from '../cli/internal/get-plugins';
import { createPluginAPI } from '../plugin/create-plugin-api';
import { ProjectDataOptions } from '../plugin/plugin-api';
import { clearProjectCache } from '../cache/project-cache';
import { getDaemonSocketPath } from './socket-path';
import { createEngineLintHost } from './engine-lint-host';
import {
  createLineDecoder,
  DaemonRequest,
  DaemonResponse,
  encodeMessage,
  HandshakeResult,
} from './protocol';
import { startWatcher } from './watcher';

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

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

type EngineLintHost = ReturnType<typeof createEngineLintHost>;

/** @internal Startup gate kept injectable so flag-off initialization is testable. */
export function createEngineLintHostIfEnabled(
  rootDir: string,
  createHost: typeof createEngineLintHost = createEngineLintHost,
): EngineLintHost | undefined {
  return process.env['SHERIFF_ENGINE'] === '1'
    ? createHost(rootDir)
    : undefined;
}

/**
 * Long-running sheriff process. Serves verify/getProjectData/getConfig/
 * lintFile over a local socket while a filesystem watcher keeps the
 * project cache warm and exact. The process is disposable by design:
 * version mismatches, config changes, and idle timeouts all end it, and
 * clients respawn it on demand.
 */
export function startDaemonServer(
  options: DaemonServerOptions = {},
): Promise<DaemonServer> {
  const rootDir = options.rootDir ?? process.cwd();
  const idleTimeoutMs = resolveIdleTimeout(options.idleTimeoutMs);
  const log = options.log ?? (() => void 0);
  const exit = options.exit ?? (() => process.exit(0));
  const socketPath = getDaemonSocketPath(rootDir);
  const engineLintHost = createEngineLintHostIfEnabled(rootDir);

  let shutdown: (reason: string) => void = () => void 0;

  const idleTimer = setTimeout(() => shutdown('idle timeout'), idleTimeoutMs);
  idleTimer.unref();

  const watcher = startWatcher({
    rootDir,
    // the config is evaluated code; a fresh process is the only clean re-eval
    onConfigChange: () => shutdown('sheriff.config.ts changed'),
    onInvalidate: (file) => {
      engineLintHost?.invalidate();
      log(`invalidated ${file}`);
    },
  });

  const server = net.createServer((socket) => {
    socket.setEncoding('utf-8');
    const decode = createLineDecoder((line) => {
      idleTimer.refresh();
      const response = handleRequestLine(
        line,
        rootDir,
        shutdown,
        engineLintHost,
      );
      socket.write(encodeMessage(response));
    });
    socket.on('data', decode);
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      watcher.close();
      engineLintHost?.invalidate();
      clearTimeout(idleTimer);
      reject(error);
    });
    removeStaleSocket(socketPath);
    server.listen(socketPath, () => {
      log(`sheriff daemon listening on ${socketPath} (pid ${process.pid})`);

      shutdown = (reason: string) => {
        log(`sheriff daemon shutting down: ${reason}`);
        watcher.close();
        engineLintHost?.invalidate();
        clearTimeout(idleTimer);
        server.close();
        removeStaleSocket(socketPath);
        // exit asynchronously so a pending response can flush first
        setTimeout(exit, 50).unref();
      };

      resolve({
        socketPath,
        close: () => {
          watcher.close();
          engineLintHost?.invalidate();
          clearTimeout(idleTimer);
          server.close();
          removeStaleSocket(socketPath);
        },
      });
    });
  });
}

function handleRequestLine(
  line: string,
  rootDir: string,
  shutdown: (reason: string) => void,
  engineLintHost: EngineLintHost | undefined,
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
      result: executeMethod(request, rootDir, shutdown, engineLintHost),
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
  engineLintHost: EngineLintHost | undefined,
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
        engineLintHost,
      );
    case 'clearCache':
      clearProjectCache();
      engineLintHost?.invalidate();
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
function lintFile(
  filename: string,
  fileContent: string | undefined,
  engineLintHost: EngineLintHost | undefined,
) {
  if (engineLintHost) {
    const engineResult = engineLintHost.lintFileViaEngine(
      filename,
      fileContent,
    );
    if (engineResult) {
      return engineResult;
    }
  }

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

function removeStaleSocket(socketPath: string): void {
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // another process may have removed it already
    }
  }
}

function resolveIdleTimeout(idleTimeoutMs: number | undefined): number {
  const override = Number(process.env['SHERIFF_DAEMON_IDLE_MS']);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
}
