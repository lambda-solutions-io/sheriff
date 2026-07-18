import { SheriffPluginAPI } from './plugin-api';

export interface SheriffPlugin {
  readonly name: string;
  readonly description?: string;
  execute(args: string[], api: SheriffPluginAPI): Promise<void>;
}
