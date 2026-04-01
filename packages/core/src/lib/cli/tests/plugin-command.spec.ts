import { describe, expect, it, vi } from 'vitest';
import {
  PluginExecutionError,
  PluginNotFoundError,
} from '../../error/user-error';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { createProject } from '../../test/project-creator';
import '../../test/expect.extensions';
import { SheriffPlugin } from '../../plugin/plugin';
import { SheriffPluginAPI } from '../../plugin/plugin-api';
import { executePlugin } from '../plugin-command';

const createMockPlugin = (
  name: string,
  executeFn?: (args: string[], api: SheriffPluginAPI) => Promise<void>,
): SheriffPlugin => ({
  name,
  execute: executeFn ?? (async () => {}),
});

const pluginConfig = (plugins: SheriffPlugin[]) => ({
  version: 1 as const,
  autoTagging: true,
  modules: {},
  depRules: {},
  enableBarrelLess: false,
  encapsulationPattern: 'internal',
  excludeRoot: false,
  log: false,
  isConfigFileMissing: false,
  entryFile: 'src/main.ts',
  barrelFileName: 'index.ts',
  entryPoints: undefined,
  ignoreFileExtensions: [],
  plugins,
});

describe('executePlugin', () => {
  it('should execute the matching plugin', async () => {
    const executeMock = vi.fn<
      (args: string[], api: SheriffPluginAPI) => Promise<void>
    >();
    const plugin = createMockPlugin('reporter', executeMock);

    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: {},
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': [],
      },
    });

    await executePlugin('reporter', ['--html'], [plugin], pluginConfig([plugin]));

    expect(executeMock).toHaveBeenCalledWith(['--html'], expect.any(Object));
  });

  it('should throw when plugin is missing', async () => {
    await expect(executePlugin('missing', [], [], pluginConfig([]))).rejects.toThrow(
      PluginNotFoundError,
    );
  });

  it('should wrap plugin errors', async () => {
    const plugin = createMockPlugin('reporter', async () => {
      throw new Error('plugin crashed');
    });

    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: {},
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': [],
      },
    });

    await expect(
      executePlugin('reporter', [], [plugin], pluginConfig([plugin])),
    ).rejects.toThrow(PluginExecutionError);
  });
});
