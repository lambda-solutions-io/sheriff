import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toFsPath } from '../../file-info/fs-path';
import { useDefaultFs } from '../../fs/getFs';
import { invalidatePath } from '../../cache/project-cache';
import { startWatcher } from '../watcher';

/**
 * Minimal `fs.FSWatcher` stand-in: an EventEmitter with the `close`
 * method `startWatcher` calls, nothing more.
 */
class FakeFsWatcher extends EventEmitter {
  close = vi.fn();
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, watch: vi.fn() };
});

vi.mock('../../cache/project-cache', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../cache/project-cache')>();
  return {
    ...actual,
    invalidatePath: vi.fn(),
    invalidateStructure: vi.fn(),
  };
});

describe('startWatcher', () => {
  afterEach(() => {
    vi.mocked(fs.watch).mockReset();
  });

  it('should route fs.watch errors to onError instead of leaving them uncaught', () => {
    const fakeWatcher = new FakeFsWatcher();
    vi.mocked(fs.watch).mockReturnValue(
      fakeWatcher as unknown as fs.FSWatcher,
    );

    const onError = vi.fn();
    const watcher = startWatcher({ rootDir: '/does/not/matter', onError });

    const enospc = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });

    // Regression for #60: `fs.watch` had no 'error' listener attached, so
    // emitting 'error' on the real FSWatcher rethrows as an uncaught
    // exception. Node's EventEmitter mirrors that: emit('error') throws
    // synchronously when there is no listener. If startWatcher fails to
    // attach one, this line throws and the test fails.
    expect(() => fakeWatcher.emit('error', enospc)).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(enospc);

    watcher.close();
    expect(fakeWatcher.close).toHaveBeenCalled();
  });

  it('should not throw when a watcher error occurs and no onError is given', () => {
    const fakeWatcher = new FakeFsWatcher();
    vi.mocked(fs.watch).mockReturnValue(
      fakeWatcher as unknown as fs.FSWatcher,
    );

    startWatcher({ rootDir: '/does/not/matter' });

    expect(() =>
      fakeWatcher.emit('error', new Error('EPERM')),
    ).not.toThrow();
  });

  it('should not invalidate a deleted file as an FsPath even if previously validated', () => {
    useDefaultFs();
    const fakeWatcher = new FakeFsWatcher();
    vi.mocked(fs.watch).mockReturnValue(
      fakeWatcher as unknown as fs.FSWatcher,
    );

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-watcher-'));
    const filePath = path.join(rootDir, 'index.ts');

    try {
      fs.writeFileSync(filePath, '');
      // an earlier verify run validated the file
      toFsPath(filePath);
      fs.rmSync(filePath);

      const onInvalidate = vi.fn();
      startWatcher({ rootDir, onInvalidate });
      const listener = vi.mocked(fs.watch).mock.calls[0][2] as (
        eventType: string,
        filename: string,
      ) => void;

      // deleted files must not re-enter the caches as valid FsPaths;
      // the watcher relies on `toFsPath` throwing for them
      listener('rename', 'index.ts');

      expect(invalidatePath).not.toHaveBeenCalled();
      expect(onInvalidate).toHaveBeenCalledWith(filePath);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
