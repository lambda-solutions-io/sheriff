import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { clearProjectCache } from '@lambda-solutions/sheriff-core';
import {
  createConnection,
  createMessageConnection,
  InitializeResult,
  MessageConnection,
  PublishDiagnosticsNotification,
  PublishDiagnosticsParams,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDefaultFs } from '../../../core/src/lib/fs/getFs';
import { Diagnostic, DiagnosticSeverity } from './diagnostics';
import { createSheriffLspServer } from './lsp-server';
import { filePathToUri } from './uri';

describe('Sheriff LSP server', () => {
  let harnesses: ServerHarness[] = [];
  let tmpDirs: string[] = [];

  beforeEach(() => {
    harnesses = [];
    tmpDirs = [];
    useDefaultFs();
    clearProjectCache();
  });

  afterEach(() => {
    clearProjectCache();
    for (const harness of harnesses) {
      harness.dispose();
    }
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not diagnose documents opened before initialization', async () => {
    const createDiagnostics = vi.fn(() => [testDiagnostic]);
    const harness = await createServer({
      createDiagnostics,
      initialize: false,
    });

    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: 'file:///test.ts',
        languageId: 'typescript',
        version: 1,
        text: 'opened',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(createDiagnostics).not.toHaveBeenCalled();
    expect(harness.diagnostics).toEqual([]);
  });

  it('waits for the initialized notification before diagnosing eager documents', async () => {
    const createDiagnostics = vi.fn(() => [testDiagnostic]);
    const harness = await createServer({
      createDiagnostics,
      sendInitialized: false,
    });
    const uri = 'file:///eager.ts';

    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: 'opened eagerly',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(createDiagnostics).not.toHaveBeenCalled();
    expect(harness.diagnostics).toEqual([]);

    const published = harness.nextDiagnostics();
    await harness.client.sendNotification('initialized', {});

    expect(await published).toEqual({
      uri,
      version: 1,
      diagnostics: [testDiagnostic],
    });
  });

  it('advertises incremental sync and diagnoses unsaved ranged changes', async () => {
    const project = createFixtureProject({ withConfig: true });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const harness = await createServer();

    expect(harness.initializeResult?.capabilities.textDocumentSync).toBe(
      TextDocumentSyncKind.Incremental,
    );

    const opened = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: "import './local';\n",
      },
    });
    expect((await opened).diagnostics).toEqual([]);

    const changed = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 8 },
            end: { line: 0, character: 15 },
          },
          text: '../shared',
        },
      ],
    });

    expect((await changed).diagnostics).toEqual([
      expect.objectContaining({
        severity: DiagnosticSeverity.Error,
        source: 'sheriff',
        message: expect.stringContaining('cannot access'),
        range: {
          start: { line: 0, character: 8 },
          end: { line: 0, character: 17 },
        },
      }),
    ]);
  });

  it('publishes empty diagnostics when no Sheriff config is present', async () => {
    const project = createFixtureProject({ withConfig: false });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const harness = await createServer();

    const published = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: "import '../shared';\n",
      },
    });

    expect((await published).diagnostics).toEqual([]);
  });

  it('contains thrown and rejected analysis and stays responsive', async () => {
    const createDiagnostics = vi.fn((_uri: string, text: string) => {
      if (text === 'throw') {
        throw new Error('diagnostics failed');
      }
      return Promise.reject(new Error('diagnostics rejected'));
    });
    const harness = await createServer({ createDiagnostics });
    const uri = 'file:///test.ts';

    const thrown = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: 'throw',
      },
    });
    expect((await thrown).diagnostics).toEqual([]);

    const rejected = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'reject' }],
    });
    expect((await rejected).diagnostics).toEqual([]);

    await expect(
      harness.client.sendRequest('workspace/stillAlive'),
    ).rejects.toMatchObject({ code: -32601 });
  });

  it('clears diagnostics on close and cancels pending analysis', async () => {
    const createDiagnostics = vi.fn(() => [testDiagnostic]);
    const harness = await createServer({
      changeDebounceMs: 10,
      createDiagnostics,
    });
    const uri = 'file:///test.ts';

    const opened = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: 'opened',
      },
    });
    expect((await opened).diagnostics).toEqual([testDiagnostic]);

    await harness.client.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'changed' }],
    });
    const closed = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
    expect((await closed).diagnostics).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(createDiagnostics).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics).toHaveLength(2);
  });

  it('does not publish queued diagnostics after shutdown', async () => {
    const createDiagnostics = vi.fn(() => [testDiagnostic]);
    const harness = await createServer({
      changeDebounceMs: 20,
      createDiagnostics,
    });
    const uri = 'file:///test.ts';

    const opened = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: 'opened',
      },
    });
    await opened;

    await harness.client.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'changed' }],
    });
    await harness.client.sendRequest('shutdown');
    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: 'file:///after-shutdown.ts',
        languageId: 'typescript',
        version: 1,
        text: 'ignored',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(createDiagnostics).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics).toHaveLength(1);
  });

  it('drops stale overlapping analysis results and preserves their versions', async () => {
    const slowAnalysis = deferred<Diagnostic[]>();
    const freshDiagnostic = { ...testDiagnostic, message: 'fresh' };
    const createDiagnostics = vi.fn((_uri: string, text: string) =>
      text === 'old' ? slowAnalysis.promise : [freshDiagnostic],
    );
    const harness = await createServer({ createDiagnostics });
    const uri = 'file:///test.ts';

    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: 'old',
      },
    });
    await vi.waitFor(() => expect(createDiagnostics).toHaveBeenCalledTimes(1));

    const fresh = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'new' }],
    });
    expect(await fresh).toEqual({
      uri,
      version: 2,
      diagnostics: [freshDiagnostic],
    });

    slowAnalysis.resolve([testDiagnostic]);
    await slowAnalysis.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.diagnostics).toEqual([
      { uri, version: 2, diagnostics: [freshDiagnostic] },
    ]);
  });

  it('does not republish an in-flight analysis after close', async () => {
    const analysis = deferred<Diagnostic[]>();
    const createDiagnostics = vi.fn(() => analysis.promise);
    const harness = await createServer({ createDiagnostics });
    const uri = 'file:///test.ts';

    await harness.client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'typescript',
        version: 1,
        text: 'opened',
      },
    });
    await vi.waitFor(() => expect(createDiagnostics).toHaveBeenCalledOnce());

    const closed = harness.nextDiagnostics();
    await harness.client.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
    expect(await closed).toEqual({ uri, diagnostics: [] });

    analysis.resolve([testDiagnostic]);
    await analysis.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.diagnostics).toEqual([{ uri, diagnostics: [] }]);
  });

  it('disposes the diagnostics backend during shutdown', async () => {
    const disposeDiagnostics = vi.fn();
    const harness = await createServer({ disposeDiagnostics });

    await harness.client.sendRequest('shutdown');

    expect(disposeDiagnostics).toHaveBeenCalledOnce();
    harness.dispose();
    expect(disposeDiagnostics).toHaveBeenCalledOnce();
  });

  it('releases document generations on close without reviving in-flight analysis', async () => {
    const analysis = deferred<Diagnostic[]>();
    const createDiagnostics = vi.fn(() => analysis.promise);
    const harness = await createServer({ createDiagnostics });
    const uris = Array.from(
      { length: 5 },
      (_, index) => `file:///closed-${index}.ts`,
    );
    const generationMaps = new Set<Map<unknown, unknown>>();
    const originalDelete = Map.prototype.delete;
    const deleteSpy = vi
      .spyOn(Map.prototype, 'delete')
      .mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown,
      ) {
        if (
          typeof key === 'string' &&
          uris.includes(key) &&
          typeof this.get(key) === 'number'
        ) {
          generationMaps.add(this);
        }
        return originalDelete.call(this, key);
      });

    try {
      for (const uri of uris) {
        await harness.client.sendNotification('textDocument/didOpen', {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 1,
            text: 'opened',
          },
        });
        await harness.client.sendNotification('textDocument/didChange', {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'changed' }],
        });
        await harness.client.sendNotification('textDocument/didClose', {
          textDocument: { uri },
        });
      }

      await vi.waitFor(() =>
        expect(harness.diagnostics).toHaveLength(uris.length),
      );
      expect(generationMaps).toHaveLength(1);
      expect([...generationMaps][0]).toHaveLength(0);

      analysis.resolve([testDiagnostic]);
      await analysis.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(harness.diagnostics).toHaveLength(uris.length);
      expect(harness.diagnostics).toEqual(
        uris.map((uri) => ({ uri, diagnostics: [] })),
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('ignores changes for documents that were never opened', async () => {
    const createDiagnostics = vi.fn(() => []);
    const harness = await createServer({ createDiagnostics });

    await harness.client.sendNotification('textDocument/didChange', {
      textDocument: { uri: 'file:///unknown.ts', version: 1 },
      contentChanges: [{ text: 'changed' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(createDiagnostics).not.toHaveBeenCalled();
    expect(harness.diagnostics).toEqual([]);
  });

  function createFixtureProject(options: { withConfig: boolean }): string {
    const project = mkdtempSync(join(tmpdir(), 'sheriff-lsp-'));
    tmpDirs.push(project);

    mkdirSync(join(project, 'src/app'), { recursive: true });
    mkdirSync(join(project, 'src/shared'), { recursive: true });
    writeFileSync(
      join(project, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'commonjs' } }),
    );
    if (options.withConfig) {
      writeFileSync(
        join(project, 'sheriff.config.ts'),
        `export const config = {
  modules: {
    'src/app': 'app',
    'src/shared': 'shared',
  },
  depRules: {
    app: [],
  },
  enableBarrelLess: true,
};`,
      );
    }

    writeFileSync(join(project, 'src/app/main.ts'), "import './local';\n");
    writeFileSync(join(project, 'src/app/local.ts'), '');
    writeFileSync(join(project, 'src/shared/index.ts'), '');
    return project;
  }

  async function createServer(
    options: {
      createDiagnostics?: (
        uri: string,
        text: string,
      ) => Diagnostic[] | Promise<Diagnostic[]>;
      changeDebounceMs?: number;
      disposeDiagnostics?: () => void;
      initialize?: boolean;
      sendInitialized?: boolean;
    } = {},
  ): Promise<ServerHarness> {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const serverConnection = createConnection(
      new StreamMessageReader(clientToServer),
      new StreamMessageWriter(serverToClient),
    );
    const client = createMessageConnection(
      new StreamMessageReader(serverToClient),
      new StreamMessageWriter(clientToServer),
    );
    const {
      initialize = true,
      sendInitialized = initialize,
      ...serverOptions
    } = options;
    const sheriffServer = createSheriffLspServer({
      connection: serverConnection,
      ...serverOptions,
    });
    const diagnostics: PublishDiagnosticsParams[] = [];
    const diagnosticsWaiters: ((params: PublishDiagnosticsParams) => void)[] =
      [];

    client.onNotification(PublishDiagnosticsNotification.type, (params) => {
      diagnostics.push(params);
      diagnosticsWaiters.shift()?.(params);
    });
    serverConnection.listen();
    client.listen();

    const initializeResult = initialize
      ? await client.sendRequest<InitializeResult>('initialize', {
          processId: null,
          rootUri: null,
          capabilities: {},
        })
      : undefined;
    if (sendInitialized) {
      await client.sendNotification('initialized', {});
    }

    const harness: ServerHarness = {
      client,
      diagnostics,
      initializeResult,
      nextDiagnostics: () =>
        new Promise((resolve) => diagnosticsWaiters.push(resolve)),
      dispose: () => {
        sheriffServer.dispose();
        client.dispose();
        serverConnection.dispose();
        clientToServer.destroy();
        serverToClient.destroy();
      },
    };
    harnesses.push(harness);
    return harness;
  }
});

interface ServerHarness {
  client: MessageConnection;
  diagnostics: PublishDiagnosticsParams[];
  initializeResult?: InitializeResult;
  nextDiagnostics(): Promise<PublishDiagnosticsParams>;
  dispose(): void;
}

const testDiagnostic: Diagnostic = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  },
  severity: DiagnosticSeverity.Error,
  source: 'sheriff',
  message: 'violation',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
