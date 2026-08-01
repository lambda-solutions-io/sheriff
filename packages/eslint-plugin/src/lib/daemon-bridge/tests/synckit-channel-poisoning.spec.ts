import { readFileSync } from 'fs';
import { basename, dirname, join, sep } from 'path';
import { createSyncFn } from 'synckit';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for GH-66 against the REAL synckit implementation (no
 * mocks, real worker thread): verifies both halves of the daemon bridge's
 * recovery strategy on the synckit line that needs it.
 *
 * 1. synckit 0.8.x does not drain the MessagePort after an `Atomics.wait`
 *    timeout, so a timed-out call that later completes poisons the channel:
 *    the next call FIFO-dequeues the stale response and fails with
 *    "Expected id N but got id N-1".
 * 2. `createSyncFn` caches one channel per exact workerPath string, so
 *    recovery requires an equivalent-but-distinct path (redundant "./"
 *    segment) to obtain a genuinely fresh worker/channel.
 *
 * Newer synckit (e.g. 0.11.x, also allowed by ">=0.8.8 <1") drains stale
 * responses itself and is not poisonable, so the poisoning assertions only
 * run against an installed 0.8.x.
 */
const synckitVersion = (
  JSON.parse(
    readFileSync(
      join(dirname(require.resolve('synckit')), '..', 'package.json'),
      'utf8',
    ),
  ) as { version: string }
).version;
const isPoisonableSynckit = synckitVersion.startsWith('0.8.');

describe(`synckit channel poisoning after a timed-out call (GH-66, installed synckit ${synckitVersion})`, () => {
  it.runIf(isPoisonableSynckit)(
    'poisons the same channel with the stale response; an equivalent ' +
      'non-normalized workerPath yields a fresh working channel',
    async () => {
      const workerPath = require.resolve('./fixtures/delay.worker.cjs');
      type Delay = (ms: number) => Promise<number>;
      const syncDelay = createSyncFn<Delay>(workerPath, { timeout: 300 });

      // Call id 0 exceeds the timeout; synckit 0.8.x throws WITHOUT draining
      // the port.
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

  it.runIf(!isPoisonableSynckit)(
    'self-recovers after a timed-out call on the SAME channel (no bridge recreation needed)',
    async () => {
      const workerPath = require.resolve('./fixtures/delay.worker.cjs');
      type Delay = (ms: number) => Promise<number>;
      const syncDelay = createSyncFn<Delay>(workerPath, { timeout: 300 });

      expect(() => syncDelay(1500)).toThrow(/timed-out/);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Modern synckit drains/skips the stale response internally: the same
      // channel keeps working, which is why the bridge must NOT recreate the
      // channel on a plain timeout.
      expect(syncDelay(1)).toBe(1);
    },
    20_000,
  );
});
