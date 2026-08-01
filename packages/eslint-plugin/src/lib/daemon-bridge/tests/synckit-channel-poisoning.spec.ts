import { basename, dirname, sep } from 'path';
import { createSyncFn } from 'synckit';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for GH-66 against the REAL synckit implementation (no
 * mocks, real worker thread): verifies both halves of the daemon bridge's
 * recovery strategy.
 *
 * 1. synckit 0.8.8 does not drain the MessagePort after an `Atomics.wait`
 *    timeout, so a timed-out call that later completes poisons the channel:
 *    the next call FIFO-dequeues the stale response and fails with
 *    "Expected id N but got id N-1".
 * 2. `createSyncFn` caches one channel per exact workerPath string, so
 *    recovery requires an equivalent-but-distinct path (redundant "./"
 *    segment) to obtain a genuinely fresh worker/channel.
 */
describe('synckit channel poisoning after a timed-out call (GH-66)', () => {
  it(
    'poisons the same channel with the stale response; an equivalent ' +
      'non-normalized workerPath yields a fresh working channel',
    async () => {
      const workerPath = require.resolve('./fixtures/delay.worker.cjs');
      type Delay = (ms: number) => Promise<number>;
      const syncDelay = createSyncFn<Delay>(workerPath, { timeout: 300 });

      // Call id 0 exceeds the timeout; synckit throws WITHOUT draining the
      // port.
      expect(() => syncDelay(1500)).toThrow(/timed-out/);

      // Let the timed-out call complete: its response is now queued stale.
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Call id 1 FIFO-dequeues call 0's stale response.
      expect(() => syncDelay(1)).toThrow(/Expected id 1 but got id 0/);

      // The SAME path returns the SAME poisoned channel from synckit's
      // cache, so re-calling createSyncFn alone cannot recover.
      expect(createSyncFn(workerPath, { timeout: 300 })).toBe(syncDelay);

      // The bridge's recovery: a redundant "./" segment busts the per-path
      // cache while still resolving to the same file — the fresh channel
      // works.
      const equivalentPath = `${dirname(workerPath)}${sep}.${sep}${basename(
        workerPath,
      )}`;
      const freshSyncDelay = createSyncFn<Delay>(equivalentPath, {
        timeout: 5000,
      });
      expect(freshSyncDelay(1)).toBe(1);
    },
    20_000,
  );
});
