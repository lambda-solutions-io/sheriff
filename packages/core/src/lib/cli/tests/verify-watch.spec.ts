import { describe, expect, it, vi } from 'vitest';
import { verify } from '../verify';
import { verifyWatch } from '../verify-watch';

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

vi.mock('../../daemon/watcher', () => ({
  startWatcher: vi.fn(() => ({ close: vi.fn() })),
}));

describe('verifyWatch', () => {
  it('passes file filters to each verification run', () => {
    verifyWatch(['src/main.ts'], { files: ['a.ts', 'b.ts'] });

    expect(verify).toHaveBeenCalledWith(['src/main.ts'], {
      files: ['a.ts', 'b.ts'],
    });
  });
});
