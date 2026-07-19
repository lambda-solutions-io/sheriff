import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphDataProvider, GraphSnapshot } from '../../data/data-provider';
import { startUiServer, UiServer } from '../ui-server';

function fakeSnapshot(): GraphSnapshot {
  return {
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
  };
}

class FakeProvider implements GraphDataProvider {
  calls = 0;
  failing = false;

  fetchSnapshot(): Promise<GraphSnapshot> {
    this.calls++;
    if (this.failing) {
      return Promise.reject(new Error('sheriff daemon unreachable'));
    }
    return Promise.resolve(fakeSnapshot());
  }

  close(): void {}
}

describe('startUiServer', () => {
  let server: UiServer;
  let provider: FakeProvider;
  let publicDir: string;

  beforeEach(async () => {
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-ui-spec-'));
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>sheriff</h1>');
    provider = new FakeProvider();
    server = await startUiServer({ provider, port: 0, publicDir });
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  const get = (pathname: string) =>
    fetch(`http://localhost:${server.port}${pathname}`);

  it('serves the graph with a hash', async () => {
    const response = await get('/api/graph');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.changed).toBe(true);
    expect(payload.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.graph.modules).toHaveLength(1);
    expect(payload.graph.files[0].id).toBe('src/main.ts');
  });

  it('short-circuits when the client hash matches', async () => {
    const first = await (await get('/api/graph')).json();
    const second = await (await get(`/api/graph?hash=${first.hash}`)).json();
    expect(second).toEqual({ hash: first.hash, changed: false });
  });

  it('responds 503 when the provider fails', async () => {
    provider.failing = true;
    const response = await get('/api/graph');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'sheriff daemon unreachable',
    });
  });

  it('serves static files from the public directory', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe('<h1>sheriff</h1>');
  });

  it('rejects unknown paths and extensions', async () => {
    expect((await get('/missing.html')).status).toBe(404);
    expect((await get('/index.txt')).status).toBe(404);
  });

  it('rejects path traversal', async () => {
    const secret = path.join(publicDir, '..', 'sheriff-ui-secret.html');
    fs.writeFileSync(secret, 'secret');
    try {
      const response = await fetch(
        `http://localhost:${server.port}/%2e%2e/sheriff-ui-secret.html`,
      );
      expect(response.status).toBe(404);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});
