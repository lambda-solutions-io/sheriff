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

  it('replays the interrupted analysis on a restarted worker', async () => {
    const onWorkerFailure = vi.fn();
    const { workers, provider } = createRestartableProvider({
      onWorkerFailure,
    });
    const interrupted = provider.createDiagnostics('file:///crash.ts', 'crash');
    const queued = provider.createDiagnostics('file:///queued.ts', 'queued');

    workers[0]?.emit('error', new Error('worker failed'));
    // The crashed worker also emits 'exit'; the stale event must be ignored.
    workers[0]?.emit('exit', 1);

    expect(onWorkerFailure).toHaveBeenCalledOnce();
    // The crashed thread is terminated so restarts do not leak workers.
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(2);
    expect(workers[1]?.requests).toEqual([
      { id: 1, uri: 'file:///crash.ts', text: 'crash' },
    ]);

    workers[1]?.respond(1, [testDiagnostic]);
    await expect(interrupted).resolves.toEqual([testDiagnostic]);
    workers[1]?.respond(2, []);
    await expect(queued).resolves.toEqual([]);
    provider.dispose();
  });

  it('rejects a request that keeps crashing the worker and moves on', async () => {
    const { workers, provider } = createRestartableProvider();
    const poisoned = provider.createDiagnostics('file:///poison.ts', 'poison');
    const healthy = provider.createDiagnostics('file:///healthy.ts', 'healthy');
    const poisonedExpectation =
      expect(poisoned).rejects.toThrow('worker failed');

    workers.at(-1)?.emit('error', new Error('worker failed'));
    workers.at(-1)?.emit('error', new Error('worker failed'));

    await poisonedExpectation;
    expect(workers).toHaveLength(3);
    expect(workers[2]?.requests).toEqual([
      { id: 2, uri: 'file:///healthy.ts', text: 'healthy' },
    ]);

    workers[2]?.respond(2, [testDiagnostic]);
    await expect(healthy).resolves.toEqual([testDiagnostic]);
    provider.dispose();
  });

  it('keeps supervising when the onWorkerFailure callback throws', async () => {
    const onWorkerFailure = vi.fn(() => {
      throw new Error('reporter broke');
    });
    const { workers, provider } = createRestartableProvider({
      onWorkerFailure,
    });
    const request = provider.createDiagnostics('file:///app.ts', 'app');

    workers[0]?.emit('error', new Error('worker failed'));

    expect(workers).toHaveLength(2);
    workers[1]?.respond(1, [testDiagnostic]);
    await expect(request).resolves.toEqual([testDiagnostic]);
    provider.dispose();
  });

  it('rejects all work and latches when no replacement worker can spawn', async () => {
    const worker = new FakeWorker();
    let spawns = 0;
    const provider = createWorkerDiagnostics({
      workerFactory: () => {
        spawns++;
        if (spawns > 1) {
          throw new Error('cannot spawn worker');
        }
        return worker;
      },
    });
    const active = provider.createDiagnostics('file:///active.ts', 'active');
    const queued = provider.createDiagnostics('file:///queued.ts', 'queued');
    const activeExpectation = expect(active).rejects.toThrow(
      'cannot spawn worker',
    );
    const queuedExpectation = expect(queued).rejects.toThrow(
      'cannot spawn worker',
    );

    worker.emit('error', new Error('worker failed'));

    await activeExpectation;
    await queuedExpectation;
    // The failed respawn is terminal: later requests reject immediately.
    await expect(
      provider.createDiagnostics('file:///later.ts', 'later'),
    ).rejects.toThrow('cannot spawn worker');
  });

  it('stops restarting once the crash budget is exhausted', async () => {
    const onWorkerFailure = vi.fn();
    const { workers, provider } = createRestartableProvider({
      onWorkerFailure,
    });

    for (let crash = 1; crash <= 4; crash++) {
      workers.at(-1)?.emit('error', new Error('worker failed'));
    }

    // Initial worker plus three restarts; the fourth crash is terminal.
    expect(workers).toHaveLength(4);
    expect(onWorkerFailure).toHaveBeenCalledTimes(4);
    await expect(
      provider.createDiagnostics('file:///after.ts', 'after'),
    ).rejects.toThrow('worker failed');
    expect(workers).toHaveLength(4);
  });

  it('refills the restart budget after a healthy response', async () => {
    const { workers, provider } = createRestartableProvider();

    // Drain the budget down to its last spare worker.
    for (let crash = 1; crash <= 3; crash++) {
      workers.at(-1)?.emit('error', new Error('worker failed'));
    }
    expect(workers).toHaveLength(4);

    const healthy = provider.createDiagnostics('file:///ok.ts', 'ok');
    workers.at(-1)?.respond(1, []);
    await expect(healthy).resolves.toEqual([]);

    // The healthy response refilled the budget, so crashes restart again.
    workers.at(-1)?.emit('error', new Error('worker failed'));
    expect(workers).toHaveLength(5);
    const next = provider.createDiagnostics('file:///next.ts', 'next');
    workers.at(-1)?.respond(2, [testDiagnostic]);
    await expect(next).resolves.toEqual([testDiagnostic]);
    provider.dispose();
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

    // The exit caused by termination must not respawn a worker.
    worker.emit('exit', 0);
    expect(worker.unref).toHaveBeenCalledOnce();
  });
});

function createRestartableProvider(
  options: { onWorkerFailure?: (error: Error) => void } = {},
): {
  workers: FakeWorker[];
  provider: ReturnType<typeof createWorkerDiagnostics>;
} {
  const workers: FakeWorker[] = [];
  const provider = createWorkerDiagnostics({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  return { workers, provider };
}

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
