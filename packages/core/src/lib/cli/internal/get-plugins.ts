import { parseConfig } from '../../config/parse-config';
import { Configuration } from '../../config/configuration';
import getFs from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { SheriffPlugin } from '../../plugin/plugin';
import { validatePlugins } from '../../plugin/plugin-resolver';

export type LoadedPlugins = {
  config?: Configuration;
  plugins: SheriffPlugin[];
};

export function getPlugins(): LoadedPlugins {
  const fs = getFs();
  const configPath = fs.join(fs.cwd(), 'sheriff.config.ts');

  if (!fs.exists(configPath)) {
    return { plugins: [] };
  }

  const config = parseConfig(toFsPath(configPath));
  const plugins = config.plugins ?? [];
  validatePlugins(plugins);

  return {
    config,
    plugins,
  };
}
