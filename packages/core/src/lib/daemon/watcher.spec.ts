import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  invalidatePath: vi.fn(),
  invalidateStructure: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('fs', () => ({ watch: mocks.watch }));
vi.mock('../cache/project-cache', () => ({
  invalidatePath: mocks.invalidatePath,
  invalidateStructure: mocks.invalidateStructure,
}));

import { startWatcher } from './watcher';

describe('daemon watcher', () => {
  let listener: (eventType: string, filename: string | Buffer | null) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.watch.mockImplementation((_rootDir, _options, callback) => {
      listener = callback;
      return { close: mocks.close };
    });
  });

  it('fully invalidates a filename-less event without treating it as config', () => {
    const onConfigChange = vi.fn();
    const onInvalidate = vi.fn();
    startWatcher({
      rootDir: '/project',
      onConfigChange,
      onInvalidate,
    });

    listener('rename', null);

    expect(mocks.invalidateStructure).toHaveBeenCalledOnce();
    expect(mocks.invalidatePath).not.toHaveBeenCalled();
    expect(onInvalidate).toHaveBeenCalledWith('/project');
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('still ignores named events from ignored directories', () => {
    const onInvalidate = vi.fn();
    startWatcher({ rootDir: '/project', onInvalidate });

    listener('change', 'node_modules/package/index.js');

    expect(mocks.invalidateStructure).not.toHaveBeenCalled();
    expect(mocks.invalidatePath).not.toHaveBeenCalled();
    expect(onInvalidate).not.toHaveBeenCalled();
  });
});
