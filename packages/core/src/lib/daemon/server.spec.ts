import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineLintHostIfEnabled } from './server';

const originalEngineFlag = process.env['SHERIFF_ENGINE'];

describe('daemon engine startup gate', () => {
  afterEach(() => {
    if (originalEngineFlag === undefined) {
      delete process.env['SHERIFF_ENGINE'];
    } else {
      process.env['SHERIFF_ENGINE'] = originalEngineFlag;
    }
  });

  it('does not construct or load the engine host when the flag is unset', () => {
    delete process.env['SHERIFF_ENGINE'];
    const createHost = vi.fn(() => {
      throw new Error('native engine should not load');
    });

    expect(
      createEngineLintHostIfEnabled('/project', createHost),
    ).toBeUndefined();
    expect(createHost).not.toHaveBeenCalled();
  });
});
