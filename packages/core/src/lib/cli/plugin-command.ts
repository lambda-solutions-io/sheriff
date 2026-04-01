import { Configuration } from '../config/configuration';
import { PluginExecutionError } from '../error/user-error';
import { createPluginAPI } from '../plugin/create-plugin-api';
import { SheriffPlugin } from '../plugin/plugin';
import { findPluginByName } from '../plugin/plugin-resolver';

export async function executePlugin(
  pluginName: string,
  args: string[],
  plugins: SheriffPlugin[],
  config: Configuration,
): Promise<void> {
  const plugin = findPluginByName(pluginName, plugins);
  const api = createPluginAPI(config);

  try {
    await plugin.execute(args, api);
  } catch (error) {
    throw new PluginExecutionError(
      pluginName,
      error instanceof Error ? error.message : String(error),
    );
  }
}
