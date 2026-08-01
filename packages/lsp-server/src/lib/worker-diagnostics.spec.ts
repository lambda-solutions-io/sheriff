import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticSeverity } from './diagnostics';
import {
  createWorkerDiagnostics,
  DiagnosticsSupersededError,
  DiagnosticsWorker,
} from './worker-diagnostics';

describe('worker diagnostics', () => {
  it('runs one analysis at a time and keeps only the latest queued revision per URI', async () => {
    const worker = new FakeWorker();
    const provider = createWorkerDiagnostics({ workerFactory: () => worker });
    const first = provider.createDiagnostics('file:///app.ts', 'first');
    const superseded = provider.createDiagnostics(
      'file:///app.ts',
      'superseded',
    );
    const latest = provider.createDiagnostics('file:///app.ts', 'latest');

    expect(worker.requests).toEqual([
      { id: 1, uri: 'file:///app.ts', text: 'first' },
    ]);
    await expect(superseded).rejects.toBeInstanceOf(DiagnosticsSupersededError);

    worker.respond(1, [testDiagnostic]);
    await expect(first).resolves.toEqual([testDiagnostic]);
    expect(worker.requests).toEqual([
      { id: 1, uri: 'file:///app.ts', text: 'first' },
      { id: 3, uri: 'file:///app.ts', text: 'latest' },
    ]);

    worker.respond(3, []);
    await expect(latest).resolves.toEqual([]);
    provider.dispose();
  });

  it('rejects active and queued work when the worker fails', async () => {
    const worker = new FakeWorker();
    const provider = createWorkerDiagnostics({ workerFactory: () => worker });
    const active = provider.createDiagnostics('file:///active.ts', 'active');
    const queued = provider.createDiagnostics('file:///queued.ts', 'queued');
    const activeExpectation = expect(active).rejects.toThrow('worker failed');
    const queuedExpectation = expect(queued).rejects.toThrow('worker failed');

    worker.emit('error', new Error('worker failed'));

    await activeExpectation;
    await queuedExpectation;
  });

  it('unrefs and terminates the worker on disposal', async () => {
    const worker = new FakeWorker();
    const provider = createWorkerDiagnostics({ workerFactory: () => worker });
    const active = provider.createDiagnostics('file:///active.ts', 'active');
    const activeExpectation = expect(active).rejects.toThrow(
      'diagnostics worker disposed',
    );

    expect(worker.unref).toHaveBeenCalledOnce();
    provider.dispose();

    await activeExpectation;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

class FakeWorker extends EventEmitter implements DiagnosticsWorker {
  requests: { id: number; uri: string; text: string }[] = [];
  unref = vi.fn();
  terminate = vi.fn(async () => 0);

  postMessage(request: { id: number; uri: string; text: string }): void {
    this.requests.push(request);
  }

  respond(id: number, diagnostics: (typeof testDiagnostic)[]): void {
    this.emit('message', { id, diagnostics });
  }
}

const testDiagnostic = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  },
  severity: DiagnosticSeverity.Error,
  source: 'sheriff' as const,
  message: 'violation',
};
