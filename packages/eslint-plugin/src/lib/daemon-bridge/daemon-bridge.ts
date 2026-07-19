import { createSyncFn } from 'synckit';

export interface DependencyRuleViolationInfo {
  fromTag: string;
  toTags: string[];
  rawImport: string;
}

export interface ExternalRuleViolationInfo {
  fromTag: string;
  externalLibrary: string;
}

export interface DaemonLintResult {
  dependencyRuleViolations: DependencyRuleViolationInfo[];
  encapsulationViolations: string[];
  externalRuleViolations: ExternalRuleViolationInfo[];
  /**
   * Raw specifiers of unresolvable relative imports (e.g. a typo'd './foo').
   * The in-process rules report these; the daemon must too, or the daemon-on
   * violation count silently diverges from the default in-process count.
   */
  unresolvableImports: string[];
}

type SyncLintFile = (
  rootDir: string,
  filename: string,
  fileContent: string,
) => DaemonLintResult;

type AsyncLintFile = (
  rootDir: string,
  filename: string,
  fileContent: string,
) => Promise<DaemonLintResult>;

/**
 * Per-call RPC budget for the synckit worker. synckit's `timeout` wraps the
 * ENTIRE worker round-trip (connect + the daemon's possibly-cold `init()` +
 * lint), not just the connect. A tight bound would trip on the first real file
 * of a large/cold project and permanently disable the bridge. The daemon's own
 * ~200 ms connect timeout (DaemonClient.CONNECT_TIMEOUT_MS) still governs
 * availability; this budget only guards against a genuinely stuck worker.
 * Configurable via SHERIFF_DAEMON_TIMEOUT_MS.
 */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/**
 * A slow/errored single call falls back in-process for THAT call only. The
 * bridge is permanently disabled only after this many CONSECUTIVE per-call
 * failures, which distinguishes a transiently slow file from a truly broken
 * daemon without eagerly poisoning the whole process on the first slow file.
 */
const MAX_CONSECUTIVE_CALL_FAILURES = 3;

let daemonDisabled = false;
let syncLintFile: SyncLintFile | undefined;
let consecutiveCallFailures = 0;

export function isDaemonBridgeEnabled(): boolean {
  return process.env['SHERIFF_DAEMON'] === '1' && !daemonDisabled;
}

export function disableDaemonBridge(): void {
  daemonDisabled = true;
}

export function resetDaemonBridgeForTests(): void {
  daemonDisabled = false;
  syncLintFile = undefined;
  consecutiveCallFailures = 0;
}

function resolveCallTimeoutMs(): number {
  const override = Number(process.env['SHERIFF_DAEMON_TIMEOUT_MS']);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return DEFAULT_CALL_TIMEOUT_MS;
}

function getSyncLintFile(): SyncLintFile | undefined {
  if (syncLintFile) {
    return syncLintFile;
  }

  try {
    const worker = createSyncFn<AsyncLintFile>(resolveLintFileWorker(), {
      timeout: resolveCallTimeoutMs(),
    });
    syncLintFile = worker;
    return syncLintFile;
  } catch {
    // Worker construction failing is a setup/reachability problem, not a slow
    // file: permanently fall back for the rest of this process.
    disableDaemonBridge();
    return undefined;
  }
}

function resolveLintFileWorker(): string {
  try {
    return require.resolve('./lint-file.worker');
  } catch {
    // Source-based test runners resolve the TypeScript worker directly. The
    // published CommonJS build takes the extensionless compiled-JS path above.
    return require.resolve('./lint-file.worker.ts');
  }
}

export function lintFileViaDaemon(
  filename: string,
  fileContent: string,
): DaemonLintResult | undefined {
  if (!isDaemonBridgeEnabled()) {
    return undefined;
  }

  try {
    const lintFile = getSyncLintFile();
    if (!lintFile) {
      return undefined;
    }
    const result = lintFile(process.cwd(), filename, fileContent);
    // A successful call clears the streak; only sustained failures disable.
    consecutiveCallFailures = 0;
    return result;
  } catch {
    // A single slow/errored call (e.g. a per-call timeout on a cold init or a
    // large file) falls back in-process for THIS call only. The bridge stays
    // on so later files can still use the daemon. It is disabled permanently
    // only after repeated consecutive failures, which indicates a genuinely
    // broken daemon rather than one slow file.
    consecutiveCallFailures += 1;
    if (consecutiveCallFailures >= MAX_CONSECUTIVE_CALL_FAILURES) {
      disableDaemonBridge();
    }
    return undefined;
  }
}
