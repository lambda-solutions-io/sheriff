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
  on(
    event: 'message',
    listener: (response: DiagnosticsResponse) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  unref(): void;
  terminate(): Promise<number>;
}

export interface WorkerDiagnosticsOptions {
  workerFactory?: () => DiagnosticsWorker;
}

export interface WorkerDiagnostics {
  createDiagnostics(uri: string, text: string): Promise<Diagnostic[]>;
  dispose(): void;
}

interface DiagnosticsJob {
  request: DiagnosticsRequest;
  resolve: (diagnostics: Diagnostic[]) => void;
  reject: (error: Error) => void;
}

/**
 * Runs Sheriff analysis outside the LSP transport thread. Only one analysis is
 * sent to the worker at a time, and queued revisions of the same document are
 * coalesced so obsolete editor buffers do not consume CPU.
 */
export function createWorkerDiagnostics(
  options: WorkerDiagnosticsOptions = {},
): WorkerDiagnostics {
  const worker = (options.workerFactory ?? createDefaultWorker)();
  const pendingByUri = new Map<string, DiagnosticsJob>();
  let nextRequestId = 1;
  let active: DiagnosticsJob | undefined;
  let terminalError: Error | undefined;

  worker.unref();
  worker.on('message', finishActiveJob);
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!terminalError) {
      fail(new Error(`diagnostics worker exited with code ${code}`));
    }
  });

  function createDiagnostics(
    uri: string,
    text: string,
  ): Promise<Diagnostic[]> {
    if (terminalError) {
      return Promise.reject(terminalError);
    }

    return new Promise((resolve, reject) => {
      const job: DiagnosticsJob = {
        request: { id: nextRequestId++, uri, text },
        resolve,
        reject,
      };

      if (!active) {
        start(job);
        return;
      }

      const superseded = pendingByUri.get(uri);
      if (superseded) {
        superseded.resolve([]);
        pendingByUri.delete(uri);
      }
      pendingByUri.set(uri, job);
    });
  }

  function start(job: DiagnosticsJob): void {
    active = job;
    worker.postMessage(job.request);
  }

  function finishActiveJob(response: DiagnosticsResponse): void {
    if (!active || response.id !== active.request.id) {
      return;
    }

    const finished = active;
    active = undefined;
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

  function fail(error: Error): void {
    if (terminalError) {
      return;
    }
    terminalError = error;
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
      fail(new Error('diagnostics worker disposed'));
      void worker.terminate();
    },
  };
}

function createDefaultWorker(): DiagnosticsWorker {
  return new Worker(require.resolve('./diagnostics-worker'));
}
