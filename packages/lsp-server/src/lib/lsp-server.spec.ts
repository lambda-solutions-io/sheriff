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

  it('advertises incremental sync and diagnoses unsaved ranged changes', async () => {
    const project = createFixtureProject({ withConfig: true });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const harness = await createServer();

    expect(harness.initializeResult.capabilities.textDocumentSync).toBe(
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
    const sheriffServer = createSheriffLspServer({
      connection: serverConnection,
      ...options,
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

    const initializeResult = await client.sendRequest<InitializeResult>(
      'initialize',
      {
        processId: null,
        rootUri: null,
        capabilities: {},
      },
    );
    await client.sendNotification('initialized', {});

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
  initializeResult: InitializeResult;
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
