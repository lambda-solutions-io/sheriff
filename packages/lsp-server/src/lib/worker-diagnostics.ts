import { Worker } from 'worker_threads';
import { Diagnostic } from './diagnostics';

interface DiagnosticsRequest {
  id: number;
  uri: string;
  text: string;
}

interface DiagnosticsResponse {
  id: number;
  diagnostics: Diagnostic[];
}

export interface DiagnosticsWorker {
  postMessage(request: DiagnosticsRequest): void;
  on(event: 'message', listener: (response: DiagnosticsResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  unref(): void;
  terminate(): Promise<number>;
}

export interface WorkerDiagnosticsOptions {
  workerFactory?: () => DiagnosticsWorker;
  /** Invoked on every worker crash so callers can surface it to the user. */
  onWorkerFailure?: (error: Error) => void;
}

export interface WorkerDiagnostics {
  createDiagnostics(uri: string, text: string): Promise<Diagnostic[]>;
  dispose(): void;
}

interface DiagnosticsJob {
  request: DiagnosticsRequest;
  resolve: (diagnostics: Diagnostic[]) => void;
  reject: (error: Error) => void;
  /** How often the request has been sent to a worker. */
  attempts: number;
}

export class DiagnosticsSupersededError extends Error {
  constructor(uri: string) {
    super(`diagnostics request superseded for ${uri}`);
    this.name = 'DiagnosticsSupersededError';
  }
}

export function isDiagnosticsSupersededError(
  error: unknown,
): error is DiagnosticsSupersededError {
  return error instanceof DiagnosticsSupersededError;
}

const MAX_WORKER_RESTARTS = 3;
const MAX_JOB_ATTEMPTS = 2;

/**
 * Runs Sheriff analysis outside the LSP transport thread. Only one analysis is
 * sent to the worker at a time, and queued revisions of the same document are
 * coalesced so obsolete editor buffers do not consume CPU. A crashed worker is
 * restarted (the budget refills after every healthy response) and the
 * interrupted analysis is replayed, so a single failure does not silently
 * disable diagnostics for the rest of the session.
 */
export function createWorkerDiagnostics(
  options: WorkerDiagnosticsOptions = {},
): WorkerDiagnostics {
  const workerFactory = options.workerFactory ?? createDefaultWorker;
  const pendingByUri = new Map<string, DiagnosticsJob>();
  let nextRequestId = 1;
  let active: DiagnosticsJob | undefined;
  let terminalError: Error | undefined;
  let remainingRestarts = MAX_WORKER_RESTARTS;
  // Listeners registered in spawnWorker only read `worker` asynchronously,
  // so the self-reference during the initial spawn is safe.
  let worker = spawnWorker();

  function spawnWorker(): DiagnosticsWorker {
    const spawned = workerFactory();
    spawned.unref();
    spawned.on('message', (response) => {
      // Ignore stale events from an already replaced worker.
      if (worker === spawned) {
        finishActiveJob(response);
      }
    });
    spawned.on('error', (error) => handleWorkerFailure(spawned, error));
    spawned.on('exit', (code) =>
      handleWorkerFailure(
        spawned,
        new Error(`diagnostics worker exited with code ${code}`),
      ),
    );
    return spawned;
  }

  function handleWorkerFailure(failed: DiagnosticsWorker, error: Error): void {
    // A crashed worker emits both 'error' and 'exit'; only the first event of
    // the current worker counts, and disposal must not trigger a restart.
    if (worker !== failed || terminalError) {
      return;
    }

    notifyWorkerFailure(error);
    // An 'error' event does not guarantee the thread is gone; terminate so
    // restarts cannot accumulate orphaned worker threads.
    try {
      void failed.terminate().catch(() => undefined);
    } catch {
      // Best-effort cleanup must never break worker supervision.
    }

    if (remainingRestarts === 0) {
      failTerminally(error);
      return;
    }
    remainingRestarts--;

    try {
      worker = spawnWorker();
      resumeInterruptedWork(error);
    } catch (respawnError) {
      // Without a replacement worker there is no recovery path; latch so
      // later requests reject instead of parking in the queue forever.
      failTerminally(toError(respawnError));
    }
  }

  function notifyWorkerFailure(error: Error): void {
    try {
      options.onWorkerFailure?.(error);
    } catch {
      // Crash reporting must never break worker supervision.
    }
  }

  function resumeInterruptedWork(error: Error): void {
    if (!active) {
      return;
    }
    if (active.attempts < MAX_JOB_ATTEMPTS) {
      // Replay the interrupted analysis so the editor does not keep stale
      // squiggles until the next keystroke.
      start(active);
      return;
    }
    // A request that repeatedly crashes the worker is poisonous: reject it
    // instead of burning the whole restart budget on it, and move on.
    const poisoned = active;
    active = undefined;
    poisoned.reject(error);
    startNextJob();
  }

  function failTerminally(error: Error): void {
    terminalError = error;
    rejectAllJobs(error);
  }

  function createDiagnostics(uri: string, text: string): Promise<Diagnostic[]> {
    if (terminalError) {
      return Promise.reject(terminalError);
    }

    return new Promise((resolve, reject) => {
      const job: DiagnosticsJob = {
        request: { id: nextRequestId++, uri, text },
        resolve,
        reject,
        attempts: 0,
      };

      if (!active) {
        start(job);
        return;
      }

      const superseded = pendingByUri.get(uri);
      if (superseded) {
        superseded.reject(new DiagnosticsSupersededError(uri));
        pendingByUri.delete(uri);
      }
      pendingByUri.set(uri, job);
    });
  }

  function start(job: DiagnosticsJob): void {
    active = job;
    job.attempts++;
    worker.postMessage(job.request);
  }

  function finishActiveJob(response: DiagnosticsResponse): void {
    if (!active || response.id !== active.request.id) {
      return;
    }

    const finished = active;
    active = undefined;
    // A healthy response proves the worker recovered; refill the restart
    // budget so isolated crashes hours apart cannot exhaust it.
    remainingRestarts = MAX_WORKER_RESTARTS;
    finished.resolve(response.diagnostics);
    startNextJob();
  }

  function startNextJob(): void {
    const next = pendingByUri.entries().next().value;
    if (!next) {
      return;
    }

    const [uri, job] = next;
    pendingByUri.delete(uri);
    start(job);
  }

  function rejectAllJobs(error: Error): void {
    active?.reject(error);
    active = undefined;
    for (const pending of pendingByUri.values()) {
      pending.reject(error);
    }
    pendingByUri.clear();
  }

  return {
    createDiagnostics,
    dispose: () => {
      if (!terminalError) {
        failTerminally(new Error('diagnostics worker disposed'));
      }
      void worker.terminate();
    },
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function createDefaultWorker(): DiagnosticsWorker {
  return new Worker(require.resolve('./diagnostics-worker'));
}
