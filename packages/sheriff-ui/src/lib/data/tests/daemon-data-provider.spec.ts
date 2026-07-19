import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '@lambda-solutions/sheriff-core';
import { DaemonDataProvider } from '../daemon-data-provider';

type FakeClient = {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeClient(
  handler: (method: string, params?: Record<string, unknown>) => unknown,
): FakeClient {
  return {
    request: vi.fn((method: string, params?: Record<string, unknown>) =>
      Promise.resolve(handler(method, params)),
    ),
    close: vi.fn(),
  };
}

const projectData = {
  '/project/src/main.ts': {
    module: '.',
    moduleType: 'barrel-less',
    tags: ['root'],
    imports: [],
    externalLibraries: [],
    unresolvedImports: [],
    projectName: 'app',
  },
};

function respond(method: string): unknown {
  switch (method) {
    case 'getConfig':
      return {};
    case 'getProjectData':
      return projectData;
    case 'verify':
      return {
        success: true,
        encapsulationViolationCount: 0,
        dependencyRuleViolationCount: 0,
        externalRuleViolationCount: 0,
        filesWithViolationsCount: 0,
        violations: {},
      };
    default:
      throw new Error(`unexpected method ${method}`);
  }
}

describe('DaemonDataProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches config, project data and verification from the daemon', async () => {
    const client = fakeClient(respond);
    vi.spyOn(DaemonClient, 'connect').mockResolvedValue(
      client as unknown as DaemonClient,
    );

    const provider = new DaemonDataProvider({
      rootDir: '/project',
      cliBinPath: '/sheriff/bin/main.js',
    });
    const snapshot = await provider.fetchSnapshot();

    expect(snapshot.rootDir).toBe('/project');
    expect(snapshot.entries).toEqual([{ projectName: 'app', projectData }]);
    expect(snapshot.verification?.success).toBe(true);
    expect(client.request).toHaveBeenCalledWith('getProjectData', {
      entryFile: undefined,
      options: { includeExternalLibraries: true },
    });
    expect(DaemonClient.connect).toHaveBeenCalledTimes(1);
  });

  it('fetches one project data set per configured entry point', async () => {
    const client = fakeClient((method, params) => {
      if (method === 'getConfig') {
        return { entryPoints: { app: 'src/main.ts', admin: 'src/admin.ts' } };
      }
      if (method === 'getProjectData') {
        return params?.['entryFile'] === 'src/admin.ts'
          ? {
              '/project/src/admin.ts': {
                ...projectData['/project/src/main.ts'],
                projectName: 'admin',
              },
            }
          : projectData;
      }
      return respond(method);
    });
    vi.spyOn(DaemonClient, 'connect').mockResolvedValue(
      client as unknown as DaemonClient,
    );

    const provider = new DaemonDataProvider({
      rootDir: '/project',
      cliBinPath: '/sheriff/bin/main.js',
    });
    const snapshot = await provider.fetchSnapshot();

    expect(snapshot.entries.map((entry) => entry.projectName)).toEqual([
      'app',
      'admin',
    ]);
  });

  it('reconnects and retries once when the connection dropped', async () => {
    const staleClient = fakeClient(() => {
      throw new Error('daemon connection closed');
    });
    const freshClient = fakeClient(respond);
    const connect = vi
      .spyOn(DaemonClient, 'connect')
      .mockResolvedValueOnce(staleClient as unknown as DaemonClient)
      .mockResolvedValueOnce(freshClient as unknown as DaemonClient);

    const provider = new DaemonDataProvider({
      rootDir: '/project',
      cliBinPath: '/sheriff/bin/main.js',
    });
    const snapshot = await provider.fetchSnapshot();

    expect(snapshot.entries).toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(staleClient.close).toHaveBeenCalled();
  });

  it('serializes concurrent snapshots over the shared connection', async () => {
    let active = 0;
    let maxActive = 0;
    const client = {
      request: vi.fn(async (method: string) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return respond(method);
      }),
      close: vi.fn(),
    };
    vi.spyOn(DaemonClient, 'connect').mockResolvedValue(
      client as unknown as DaemonClient,
    );

    const provider = new DaemonDataProvider({
      rootDir: '/project',
      cliBinPath: '/sheriff/bin/main.js',
    });
    const [first, second] = await Promise.all([
      provider.fetchSnapshot(),
      provider.fetchSnapshot(),
    ]);

    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(1);
    expect(maxActive).toBe(1);
  });

  it('fails when no daemon can be reached', async () => {
    vi.spyOn(DaemonClient, 'connect').mockResolvedValue(undefined);

    const provider = new DaemonDataProvider({
      rootDir: '/project',
      cliBinPath: '/sheriff/bin/main.js',
    });

    await expect(provider.fetchSnapshot()).rejects.toThrow(
      'sheriff daemon unreachable',
    );
  });
});
