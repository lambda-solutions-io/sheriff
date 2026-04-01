import { describe, expect, it } from 'vitest';
import {
  DuplicatePluginNameError,
  PluginInvalidError,
  PluginNotFoundError,
} from '../../error/user-error';
import '../../test/expect.extensions';
import { SheriffPlugin } from '../plugin';
import {
  findPluginByName,
  validatePlugin,
  validatePlugins,
} from '../plugin-resolver';

const plugin: SheriffPlugin = {
  name: 'valid',
  async execute() {},
};

describe('plugin resolver', () => {
  it('should validate a plugin', () => {
    expect(() => validatePlugin(plugin)).not.toThrow();
  });

  it('should reject non-object plugins', () => {
    expect(() => validatePlugin(undefined)).toThrowUserError(
      new PluginInvalidError('Plugin must be an object'),
    );
  });

  it('should reject plugins without a name', () => {
    expect(() =>
      validatePlugin({ execute: async () => {} }, 1),
    ).toThrowUserError(
      new PluginInvalidError("Plugin is missing a valid 'name' property", 1),
    );
  });

  it('should reject plugins without execute', () => {
    expect(() => validatePlugin({ name: 'broken' }, 2)).toThrowUserError(
      new PluginInvalidError("Plugin is missing an 'execute' method", 2),
    );
  });

  it('should validate plugin arrays and reject duplicates', () => {
    expect(() =>
      validatePlugins([plugin, { ...plugin }]),
    ).toThrowUserError(new DuplicatePluginNameError('valid'));
  });

  it('should find plugins by name', () => {
    expect(findPluginByName('valid', [plugin])).toBe(plugin);
  });

  it('should reject missing plugins', () => {
    expect(() => findPluginByName('missing', [plugin])).toThrowUserError(
      new PluginNotFoundError('missing'),
    );
  });
});
