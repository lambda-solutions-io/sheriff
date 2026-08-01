import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectCache } from '../../cache/project-cache';
import { startWatcher, type WatcherOptions } from '../../daemon/watcher';
import { cli } from '../cli';
import { verify } from '../verify';
import { verifyWatch } from '../verify-watch';

const watcherMock = vi.hoisted(() => ({
  close: vi.fn(),
  options: undefined as WatcherOptions | undefined,
}));

vi.mock('../cli', () => ({
  cli: {
    endProcessOk: vi.fn(),
    endProcessError: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('../verify', () => ({
  verify: vi.fn(),
}));

vi.mock('../../cache/project-cache', () => ({
  clearProjectCache: vi.fn(),
}));

vi.mock('../../daemon/watcher', () => ({
  startWatcher: vi.fn((options: WatcherOptions) => {
    watcherMock.options = options;
    return { close: watcherMock.close };
  }),
}));

describe('verifyWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watcherMock.options = undefined;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('passes file filters to the initial verification run', () => {
    verifyWatch(['src/main.ts'], { files: ['a.ts', 'b.ts'] });

    expect(verify).toHaveBeenCalledWith(['src/main.ts'], {
      files: ['a.ts', 'b.ts'],
    });
    expect(cli.log).toHaveBeenCalledWith(
      'watching for changes... verifying only a.ts, b.ts (ctrl+c to quit)',
    );
  });

  it('re-verifies the original files when a non-listed file changes', async () => {
    verifyWatch(['src/main.ts'], { files: ['a.ts', 'b.ts'] });

    expect(startWatcher).toHaveBeenCalledOnce();
    watcherMock.options?.onInvalidate?.('/project/src/not-listed.ts');
    await vi.advanceTimersByTimeAsync(100);

    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenNthCalledWith(2, ['src/main.ts'], {
      files: ['a.ts', 'b.ts'],
    });
  });

  it('preserves file filters when a config change triggers a rerun', async () => {
    verifyWatch(['src/main.ts'], { files: ['a.ts', 'b.ts'] });

    watcherMock.options?.onConfigChange?.('/project/sheriff.config.ts');
    await vi.advanceTimersByTimeAsync(100);

    expect(clearProjectCache).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenNthCalledWith(2, ['src/main.ts'], {
      files: ['a.ts', 'b.ts'],
    });
  });
});
