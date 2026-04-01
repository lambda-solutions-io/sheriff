import { afterEach, describe, expect, it, vi } from 'vitest';
import { version } from '../../../../package.json';
import { sheriffConfig } from '../../test/project-configurator';
import { createProject } from '../../test/project-creator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { SheriffPlugin } from '../../plugin/plugin';
import { SheriffPluginAPI } from '../../plugin/plugin-api';
import * as getPluginsModule from '../internal/get-plugins';
import { mockCli } from './helpers/mock-cli';
import { main } from '../main';

const createMockPlugin = (
  name: string,
  executeFn?: (args: string[], api: SheriffPluginAPI) => Promise<void>,
  description?: string,
): SheriffPlugin => ({
  name,
  description,
  execute: executeFn ?? (async () => {}),
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include the version in main', () => {
    const { allLogs } = mockCli();

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    main();

    expect(allLogs()).toContain(`Sheriff (${version})`);
  });

  it('should show help when no command is provided', () => {
    const { allLogs } = mockCli();

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    main();

    expect(allLogs()).toContain('Commands:');
    expect(allLogs()).toContain('sheriff verify');
    expect(allLogs()).toContain('sheriff version');
  });

  it('should show plugins in help output', () => {
    const { allLogs } = mockCli();
    const plugin = createMockPlugin(
      'junit',
      async () => {},
      'Generate JUnit reports',
    );

    vi.spyOn(getPluginsModule, 'getPlugins').mockReturnValue({
      config: undefined,
      plugins: [plugin],
    });

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    main();

    expect(allLogs()).toContain('Plugins:');
    expect(allLogs()).toContain('sheriff junit: Generate JUnit reports');
  });

  it('should not show plugins section when no plugins are configured', () => {
    const { allLogs } = mockCli();

    vi.spyOn(getPluginsModule, 'getPlugins').mockReturnValue({
      config: undefined,
      plugins: [],
    });

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    main();

    expect(allLogs()).not.toContain('Plugins:');
  });

  it('should execute a configured plugin', async () => {
    const executeMock = vi.fn<
      (args: string[], api: SheriffPluginAPI) => Promise<void>
    >();
    const plugin = createMockPlugin('reporter', executeMock);
    const config = {
      version: 1,
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
      plugins: [plugin],
    };

    mockCli();
    vi.spyOn(getPluginsModule, 'getPlugins').mockReturnValue({
      config,
      plugins: [plugin],
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

    main('reporter', '--format=xml', 'report.xml');

    await vi.waitFor(() => {
      expect(executeMock).toHaveBeenCalledWith(
        ['--format=xml', 'report.xml'],
        expect.any(Object),
      );
    });
  });

  it('should prefer built-in commands over plugins with the same name', () => {
    const { allLogs } = mockCli();
    const executeMock = vi.fn<
      (args: string[], api: SheriffPluginAPI) => Promise<void>
    >();
    const plugin = createMockPlugin('verify', executeMock);

    vi.spyOn(getPluginsModule, 'getPlugins').mockReturnValue({
      config: undefined,
      plugins: [plugin],
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

    main('verify');

    expect(executeMock).not.toHaveBeenCalled();
    expect(allLogs()).toContain('No issues found');
  });

  it('should show help for unknown commands', () => {
    const { allLogs } = mockCli();

    vi.spyOn(getPluginsModule, 'getPlugins').mockReturnValue({
      config: undefined,
      plugins: [],
    });

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    main('unknown-command');

    expect(allLogs()).toContain('Commands:');
  });

  it('should surface plugin-loading errors', async () => {
    const { allErrorLogs } = mockCli();

    vi.spyOn(getPluginsModule, 'getPlugins').mockImplementation(() => {
      throw new Error('broken plugins');
    });

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [],
      },
    });

    main('reporter');

    await vi.waitFor(() => {
      expect(allErrorLogs()).toContain('broken plugins');
    });
  });
});
