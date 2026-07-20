import { describe, expect, it } from 'vitest';
import type { SheriffPluginAPI } from '@lambda-solutions/sheriff-core';
import { GraphDataProvider, GraphSnapshot } from '../../data/data-provider';
import { SheriffUiPlugin } from '../sheriff-ui-plugin';

function fakeApi(logs: string[]): SheriffPluginAPI {
  return {
    verify: () => {
      throw new Error('not used');
    },
    getProjectData: () => {
      throw new Error('not used');
    },
    getConfig: () => ({}),
    log: (message: string) => logs.push(message),
    logError: (message: string) => logs.push(`error: ${message}`),
  };
}

class FakeProvider implements GraphDataProvider {
  closed = false;
  lastEntryFile: string | undefined;

  fetchSnapshot(entryFile?: string): Promise<GraphSnapshot> {
    this.lastEntryFile = entryFile;
    return Promise.resolve({
      entries: [
        {
          projectName: 'app',
          projectData: {
            '/project/src/main.ts': {
              module: '.',
              moduleType: 'barrel-less',
              tags: ['root'],
              imports: [],
              externalLibraries: [],
              unresolvedImports: [],
              projectName: 'app',
            },
          },
        },
      ],
      verification: undefined,
      rootDir: '/project',
    });
  }

  close(): void {
    this.closed = true;
  }
}

describe('SheriffUiPlugin', () => {
  it('has the plugin contract fields', () => {
    const plugin = new SheriffUiPlugin();
    expect(plugin.name).toBe('ui');
    expect(plugin.description).toBe('Open Sheriff UI');
  });

  it('prints the graph as JSON with --json and closes the provider', async () => {
    const provider = new FakeProvider();
    const plugin = new SheriffUiPlugin({
      providerFactory: () => provider,
    });
    const logs: string[] = [];

    await plugin.execute(['--json'], fakeApi(logs));

    expect(logs).toHaveLength(1);
    const graph = JSON.parse(logs[0]);
    expect(graph.modules).toHaveLength(1);
    expect(graph.files[0].id).toBe('src/main.ts');
    expect(provider.closed).toBe(true);
  });

  it('passes --entry-file through to the provider', async () => {
    const provider = new FakeProvider();
    const plugin = new SheriffUiPlugin({ providerFactory: () => provider });

    await plugin.execute(
      ['--json', '--entry-file', 'src/other.ts'],
      fakeApi([]),
    );

    expect(provider.lastEntryFile).toBe('src/other.ts');
  });

  it('closes the provider when parsing-independent execution fails', async () => {
    const provider = new FakeProvider();
    provider.fetchSnapshot = () => Promise.reject(new Error('boom'));
    const plugin = new SheriffUiPlugin({ providerFactory: () => provider });

    await expect(plugin.execute(['--json'], fakeApi([]))).rejects.toThrow(
      'boom',
    );
    expect(provider.closed).toBe(true);
  });
});
