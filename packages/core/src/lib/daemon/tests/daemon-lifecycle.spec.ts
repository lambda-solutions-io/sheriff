import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDaemonServer } from '../server';
import * as watcherModule from '../watcher';

/** Set by a test to make the next `net.createServer().listen` fail. */
let listenError: Error | undefined;
/** Widens the pre-listen window so a test can act inside it. */
let listenDelayMs = 0;

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof net>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const listen = server.listen.bind(server);

      if (listenError) {
        const error = listenError;
        server.listen = function fail(this: net.Server) {
          setImmediate(() => this.emit('error', error));
          return this;
        } as net.Server['listen'];
      } else if (listenDelayMs > 0) {
        const delay = listenDelayMs;
        server.listen = function delayed(
          this: net.Server,
          socketPath: string,
          onListening: () => void,
        ) {
          listen(socketPath, () => setTimeout(onListening, delay));
          return this;
        } as unknown as net.Server['listen'];
      }

      return server;
    },
  };
});

/**
 * Lifecycle of the window between creating the watcher/idle timer and
 * `listen` succeeding: nothing may leak when `listen` fails, and no
 * shutdown trigger fired in that window may be swallowed.
 */
describe('daemon server lifecycle', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    listenError = undefined;
    listenDelayMs = 0;
    vi.restoreAllMocks();
    while (cleanups.length) {
      cleanups.pop()?.();
    }
  });

  function createRootDir(): string {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sheriff-daemon-lifecycle-'),
    );
    cleanups.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    return rootDir;
  }

  function stubWatcher() {
    const close = vi.fn();
    const spy = vi
      .spyOn(watcherModule, 'startWatcher')
      .mockImplementation(() => ({ close }));
    return { close, spy };
  }

  it('should close the watcher and clear the idle timer when listen fails', async () => {
    const rootDir = createRootDir();
    const { close } = stubWatcher();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    // stands in for the EADDRINUSE a second daemon hits on Windows
    listenError = Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
    });

    await expect(startDaemonServer({ rootDir })).rejects.toThrow(
      'listen EADDRINUSE',
    );

    expect(close).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  // guards the seam with the socket-ownership fix (#42): a deferred
  // shutdown runs after `listen`, so it must still go through the inode
  // check rather than unlinking whatever now sits at the path
  it.skipIf(process.platform === 'win32')(
    'should not unlink a successor socket when a deferred shutdown runs',
    async () => {
      const rootDir = createRootDir();
      const exit = vi.fn();

      vi.spyOn(watcherModule, 'startWatcher').mockImplementation((options) => {
        // fires while `listen` is still pending
        options.onConfigChange?.(
          path.join(options.rootDir, 'sheriff.config.ts'),
        );
        return { close: vi.fn() };
      });

      const server = await startDaemonServer({ rootDir, exit });
      cleanups.push(() => server.close());
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());

      // stand in for a successor daemon claiming the freed path
      fs.writeFileSync(server.socketPath, 'successor');
      cleanups.push(() => fs.rmSync(server.socketPath, { force: true }));

      // a second release must leave the successor's file alone
      server.close();
      expect(fs.existsSync(server.socketPath)).toBe(true);
    },
  );

  it('should honour a config change that happens before listen succeeds', async () => {
    const rootDir = createRootDir();
    const exit = vi.fn();
    let onConfigChange: ((file: string) => void) | undefined;

    vi.spyOn(watcherModule, 'startWatcher').mockImplementation((options) => {
      onConfigChange = options.onConfigChange;
      // fires while `listen` is still pending
      onConfigChange?.(path.join(options.rootDir, 'sheriff.config.ts'));
      return { close: vi.fn() };
    });

    const server = await startDaemonServer({ rootDir, exit });
    cleanups.push(() => server.close());

    expect(onConfigChange).toBeDefined();
    // the stale daemon must not keep serving the old evaluated config
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it('should honour an idle timeout that fires before listen succeeds', async () => {
    const rootDir = createRootDir();
    const exit = vi.fn();
    stubWatcher();
    // an ambient override would win over `idleTimeoutMs`
    vi.stubEnv('SHERIFF_DAEMON_IDLE_MS', '');
    cleanups.push(() => vi.unstubAllEnvs());
    // the one-shot timer must outlive the window rather than be swallowed
    listenDelayMs = 50;

    const server = await startDaemonServer({
      rootDir,
      idleTimeoutMs: 1,
      exit,
    });
    cleanups.push(() => server.close());

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });
});
