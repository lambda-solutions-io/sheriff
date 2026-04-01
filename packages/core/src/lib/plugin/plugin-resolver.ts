import {
  DuplicatePluginNameError,
  PluginInvalidError,
  PluginNotFoundError,
} from '../error/user-error';
import { SheriffPlugin } from './plugin';

export function validatePlugin(
  plugin: unknown,
  index?: number,
): asserts plugin is SheriffPlugin {
  if (!plugin || typeof plugin !== 'object') {
    throw new PluginInvalidError('Plugin must be an object', index);
  }

  const pluginObject = plugin as Record<string, unknown>;

  if (
    typeof pluginObject['name'] !== 'string' ||
    pluginObject['name'].trim() === ''
  ) {
    throw new PluginInvalidError(
      "Plugin is missing a valid 'name' property",
      index,
    );
  }

  if (typeof pluginObject['execute'] !== 'function') {
    throw new PluginInvalidError(
      "Plugin is missing an 'execute' method",
      index,
    );
  }
}

export function validatePlugins(plugins: SheriffPlugin[] | undefined): void {
  if (!plugins) {
    return;
  }

  const names = new Set<string>();

  plugins.forEach((plugin, index) => {
    validatePlugin(plugin, index);

    if (names.has(plugin.name)) {
      throw new DuplicatePluginNameError(plugin.name);
    }

    names.add(plugin.name);
  });
}

export function findPluginByName(
  name: string,
  plugins: SheriffPlugin[] | undefined,
): SheriffPlugin {
  if (!plugins || plugins.length === 0) {
    throw new PluginNotFoundError(name);
  }

  const plugin = plugins.find((candidate) => candidate.name === name);

  if (!plugin) {
    throw new PluginNotFoundError(name);
  }

  return plugin;
}
