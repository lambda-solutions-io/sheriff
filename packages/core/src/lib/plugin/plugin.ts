import { SheriffPluginAPI } from './plugin-api';

export interface SheriffPlugin {
  name: string;
  description?: string;
  execute(args: string[], api: SheriffPluginAPI): Promise<void>;
}
