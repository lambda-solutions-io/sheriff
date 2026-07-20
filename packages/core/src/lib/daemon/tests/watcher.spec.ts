import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidatePath,
  invalidateStructure,
} from '../../cache/project-cache';
import { startWatcher } from '../watcher';

const watcherMocks = vi.hoisted(() => ({
  close: vi.fn(),
  existsSync: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  watcherMocks.existsSync.mockImplementation(actual.existsSync);
  return {
    ...actual,
    existsSync: watcherMocks.existsSync,
    watch: watcherMocks.watch,
  };
});

vi.mock('../../cache/project-cache', () => ({
  invalidatePath: vi.fn(),
  invalidateStructure: vi.fn(),
}));

type WatchListener = (
  eventType: 'change' | 'rename',
  filename: string | Buffer | null,
) => void;

describe('watcher', () => {
  let rootDir: string;
  let existingFile: string;
  let watchListener: WatchListener;

  beforeEach(() => {
    vi.clearAllMocks();
    watcherMocks.watch.mockImplementation((...args: unknown[]) => {
      watchListener = args[2] as WatchListener;
      return { close: watcherMocks.close };
    });
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-watcher-spec-'));
    existingFile = path.join(rootDir, 'existing.ts');
    fs.writeFileSync(existingFile, 'export const value = 1;');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it.each(['change', 'rename'] as const)(
    'should invalidate only the changed path for a content edit reported as %s',
    (eventType) => {
      const onInvalidate = vi.fn();
      startWatcher({ rootDir, onInvalidate });

      fs.appendFileSync(existingFile, '\n');
      watchListener(eventType, 'existing.ts');

      expect(onInvalidate).toHaveBeenCalledWith(existingFile);
      expect(invalidatePath).toHaveBeenCalledWith(existingFile);
      expect(invalidateStructure).not.toHaveBeenCalled();
    },
  );

  it('should invalidate structure when a file is created', () => {
    const onInvalidate = vi.fn();
    startWatcher({ rootDir, onInvalidate });
    const newFile = path.join(rootDir, 'new.ts');

    fs.writeFileSync(newFile, 'export const value = 2;');
    watchListener('rename', 'new.ts');

    expect(onInvalidate).toHaveBeenCalledWith(newFile);
    expect(invalidatePath).toHaveBeenCalledWith(newFile);
    expect(invalidateStructure).toHaveBeenCalled();
  });

  it('should invalidate structure when a file is deleted', () => {
    const onInvalidate = vi.fn();
    startWatcher({ rootDir, onInvalidate });

    fs.unlinkSync(existingFile);
    watchListener('rename', 'existing.ts');

    expect(onInvalidate).toHaveBeenCalledWith(existingFile);
    expect(invalidatePath).toHaveBeenCalledWith(existingFile);
    expect(invalidateStructure).toHaveBeenCalled();
  });

  it('should invalidate structure when existence cannot be determined', () => {
    const onInvalidate = vi.fn();
    startWatcher({ rootDir, onInvalidate });
    watcherMocks.existsSync.mockImplementationOnce(() => {
      throw new Error('existence probe failed');
    });

    watchListener('change', 'existing.ts');

    expect(onInvalidate).toHaveBeenCalledWith(existingFile);
    expect(invalidatePath).toHaveBeenCalledWith(existingFile);
    expect(invalidateStructure).toHaveBeenCalled();
  });
});
