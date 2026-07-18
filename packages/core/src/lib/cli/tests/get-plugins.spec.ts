import { describe, expect, it } from 'vitest';
import {
  DuplicatePluginNameError,
  PluginInvalidError,
} from '../../error/user-error';
import { tsConfig } from '../../test/fixtures/ts-config';
import { createProject } from '../../test/project-creator';
import '../../test/expect.extensions';
import { getPlugins } from '../internal/get-plugins';

describe('getPlugins', () => {
  it('should return empty plugins when sheriff.config.ts does not exist', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    expect(getPlugins()).toEqual({
      plugins: [],
    });
  });

  it('should return empty plugins when plugins property is undefined', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': `
export const config = {
  depRules: {},
  entryFile: 'src/main.ts',
};
      `,
      src: {
        'main.ts': [],
      },
    });

    const loaded = getPlugins();

    expect(loaded.plugins).toEqual([]);
    expect(loaded.config?.entryFile).toBe('src/main.ts');
  });

  it('should return configured plugins', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': `
export const config = {
  depRules: {},
  entryFile: 'src/main.ts',
  plugins: [
    {
      name: 'junit',
      description: 'JUnit reporter',
      async execute() {},
    },
  ],
};
      `,
      src: {
        'main.ts': [],
      },
    });

    const loaded = getPlugins();

    expect(loaded.plugins).toHaveLength(1);
    expect(loaded.plugins[0].name).toBe('junit');
    expect(loaded.plugins[0].description).toBe('JUnit reporter');
  });

  it('should throw for invalid plugins', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': `
export const config = {
  depRules: {},
  entryFile: 'src/main.ts',
  plugins: [
    {
      name: 'broken',
    },
  ],
};
      `,
      src: {
        'main.ts': [],
      },
    });

    expect(() => getPlugins()).toThrowUserError(
      new PluginInvalidError("Plugin is missing an 'execute' method", 0),
    );
  });

  it('should throw for duplicate plugin names', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': `
export const config = {
  depRules: {},
  entryFile: 'src/main.ts',
  plugins: [
    {
      name: 'duplicate',
      async execute() {},
    },
    {
      name: 'duplicate',
      async execute() {},
    },
  ],
};
      `,
      src: {
        'main.ts': [],
      },
    });

    expect(() => getPlugins()).toThrowUserError(
      new DuplicatePluginNameError('duplicate'),
    );
  });
});
