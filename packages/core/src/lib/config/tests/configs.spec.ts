import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { parseConfig } from '../parse-config';
import { toFsPath } from '../../file-info/fs-path';
import getFs, { useVirtualFs } from '../../fs/getFs';
import '../../test/expect.extensions';

/**
 * Task 4, option B: a `configs` field in the root config maps a
 * workspace-relative directory to the config file which governs it.
 *
 * These tests cover the parsing contract only. Per-file resolution is
 * covered by `resolve-config-for-file.spec.ts`.
 */
describe('configs', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  it('should default to an empty object', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { 'noTag': 'noTag' },
};
      `,
    );

    const config = parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts'));

    expect(config.configs).toEqual({});
  });

  it('should read the configs field', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  configs: {
    'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
  },
  depRules: { 'noTag': 'noTag' },
};
      `,
    );

    const config = parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts'));

    expect(config.configs).toEqual({
      'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
    });
  });

  it('should keep several entries', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  configs: {
    'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
    'apps/vertical-demo': './apps/vertical-demo/sheriff.config.ts',
  },
  depRules: { 'noTag': 'noTag' },
};
      `,
    );

    const config = parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts'));

    expect(Object.keys(config.configs)).toEqual([
      'apps/hexagonal-demo',
      'apps/vertical-demo',
    ]);
  });
});
