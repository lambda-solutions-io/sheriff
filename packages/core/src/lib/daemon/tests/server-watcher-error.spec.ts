import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDaemonServer } from '../server';
import * as watcherModule from '../watcher';

/**
 * Regression for a watcher error in the pre-listen window: `startWatcher`
 * runs (and can error) before `server.listen`'s callback assigns
 * `releaseSocket` and resolves the startup promise. ENOSPC is exactly
 * this case, since recursive watch registration fails eagerly.
 *
 * Unlike a pre-listen config change or idle timeout — routine restarts
 * that resolve startup and then replay the shutdown — a pre-listen
 * watcher error means the daemon could never safely serve, so startup
 * must reject outright instead of handing back a "successfully started"
 * daemon whose watcher is already dead.
 */
describe('startDaemonServer watcher error before listen resolves', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (cleanups.length) {
      cleanups.pop()?.();
    }
  });

  function createRootDir(): string {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-daemon-watcher-error-spec-'),
    );
    cleanups.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    return rootDir;
  }

  it('should close the watcher and reject startup instead of resolving with a dead watcher', async () => {
    const rootDir = createRootDir();
    const close = vi.fn();

    vi.spyOn(watcherModule, 'startWatcher').mockImplementation((options) => {
      // fires while `listen` is still pending
      options.onError?.(
        Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }),
      );
      return { close };
    });

    const exit = vi.fn();
    await expect(startDaemonServer({ rootDir, exit })).rejects.toThrow(
      'ENOSPC',
    );

    expect(close).toHaveBeenCalled();
    // the crash path must never leave a "daemon is up" promise resolved
    expect(exit).not.toHaveBeenCalled();
  });

  it('should shut down cleanly on a watcher error after listen succeeds', async () => {
    const rootDir = createRootDir();
    let onError: ((error: Error) => void) | undefined;
    const close = vi.fn();

    vi.spyOn(watcherModule, 'startWatcher').mockImplementation((options) => {
      onError = options.onError;
      return { close };
    });

    const exit = vi.fn();
    const server = await startDaemonServer({ rootDir, exit });
    cleanups.push(() => server.close());

    onError?.(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(close).toHaveBeenCalled();
  });
});
