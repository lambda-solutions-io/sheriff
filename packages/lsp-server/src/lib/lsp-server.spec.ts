import { afterEach, describe, expect, it, vi } from 'vitest';
import { Diagnostic } from './diagnostics';
import { createSheriffLspServer, SheriffLspServer } from './lsp-server';
import { JsonRpcMessage } from './message-codec';

describe('SheriffLspServer lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects requests and drops notifications before initialize', () => {
    const { server, messages, exitCodes, createDiagnostics } = createServer();

    server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'workspace/test' });
    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri: 'file:///test.ts', text: '', version: 1 },
      },
    });
    server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'shutdown' });

    expect(messages).toEqual([
      errorResponse(1, -32002, 'Server not initialized'),
      errorResponse(2, -32002, 'Server not initialized'),
    ]);
    expect(createDiagnostics).not.toHaveBeenCalled();

    server.handleMessage({ jsonrpc: '2.0', method: 'exit' });
    expect(exitCodes).toEqual([1]);
  });

  it('responds exactly once to requests and enforces shutdown state', () => {
    const { server, messages, exitCodes, createDiagnostics } = createServer();
    initialize(server);

    server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/didOpen',
    });
    server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'unknown/method' });
    server.handleMessage({ jsonrpc: '2.0', id: 6, method: 'exit' });
    server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'shutdown' });
    server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'unknown/after' });
    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri: 'file:///ignored.ts', text: '', version: 1 },
      },
    });

    for (const id of [0, 1, 2, 3, 4, 5, 6]) {
      expect(messages.filter((message) => message['id'] === id)).toHaveLength(
        1,
      );
    }
    expect(messages.find((message) => message['id'] === 1)).toEqual(
      errorResponse(1, -32600, 'Invalid Request'),
    );
    expect(messages.find((message) => message['id'] === 2)).toEqual(
      errorResponse(2, -32600, 'Invalid Request'),
    );
    expect(messages.find((message) => message['id'] === 3)).toEqual(
      errorResponse(3, -32601, 'Method not found: unknown/method'),
    );
    expect(messages.find((message) => message['id'] === 6)).toEqual(
      errorResponse(6, -32600, 'Invalid Request'),
    );
    expect(messages.find((message) => message['id'] === 4)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: null,
    });
    expect(messages.find((message) => message['id'] === 5)).toEqual(
      errorResponse(5, -32600, 'Invalid Request'),
    );
    expect(createDiagnostics).not.toHaveBeenCalled();

    server.handleMessage({ jsonrpc: '2.0', method: 'exit' });
    expect(exitCodes).toEqual([0]);
  });

  it('exits with code 1 when exit follows initialize without shutdown', () => {
    const { server, exitCodes } = createServer();
    initialize(server);

    server.handleMessage({ jsonrpc: '2.0', method: 'exit' });

    expect(exitCodes).toEqual([1]);
  });
});

describe('SheriffLspServer diagnostics scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('contains deferred throws and rejections so later requests still work', async () => {
    vi.useFakeTimers();
    const createDiagnostics = vi.fn((_uri: string, text: string) => {
      if (text === 'throw') {
        throw new Error('diagnostics failed');
      }
      if (text === 'reject') {
        return Promise.reject(new Error('diagnostics rejected'));
      }
      return [];
    });
    const { server, messages, exitCodes } = createServer({
      createDiagnostics,
      changeDebounceMs: 10,
    });
    initialize(server);
    open(server, 'file:///test.ts', 'safe');
    messages.length = 0;

    change(server, 'file:///test.ts', 'throw', 2);
    await vi.advanceTimersByTimeAsync(10);
    expect(lastDiagnostics(messages)).toEqual([]);

    change(server, 'file:///test.ts', 'reject', 3);
    await vi.advanceTimersByTimeAsync(10);
    expect(lastDiagnostics(messages)).toEqual([]);

    server.handleMessage({ jsonrpc: '2.0', id: 9, method: 'still/alive' });
    expect(messages.find((message) => message['id'] === 9)).toEqual(
      errorResponse(9, -32601, 'Method not found: still/alive'),
    );
    expect(exitCodes).toEqual([]);
  });

  it('ignores didChange for a document that was never opened', async () => {
    vi.useFakeTimers();
    const { server, messages, createDiagnostics } = createServer({
      changeDebounceMs: 10,
    });
    initialize(server);
    messages.length = 0;

    change(server, 'file:///unknown.ts', 'changed', 1);
    await vi.advanceTimersByTimeAsync(20);

    expect(createDiagnostics).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it('cancels a pending change diagnostic when the document closes', async () => {
    vi.useFakeTimers();
    const { server, messages, createDiagnostics } = createServer({
      changeDebounceMs: 10,
    });
    initialize(server);
    open(server, 'file:///test.ts', 'opened');
    messages.length = 0;

    change(server, 'file:///test.ts', 'changed', 2);
    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///test.ts' } },
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(createDiagnostics).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(lastDiagnostics(messages)).toEqual([]);
  });
});

function createServer(
  options: {
    createDiagnostics?: (
      uri: string,
      text: string,
    ) => Diagnostic[] | Promise<Diagnostic[]>;
    changeDebounceMs?: number;
  } = {},
) {
  const messages: JsonRpcMessage[] = [];
  const exitCodes: number[] = [];
  const createDiagnostics = options.createDiagnostics ?? vi.fn(() => []);
  const server = createSheriffLspServer({
    changeDebounceMs: options.changeDebounceMs,
    createDiagnostics,
    connection: {
      send: (message) => messages.push(message),
      exit: (code) => exitCodes.push(code),
    },
  });
  return { server, messages, exitCodes, createDiagnostics };
}

function initialize(server: SheriffLspServer): void {
  server.handleMessage({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {},
  });
}

function open(server: SheriffLspServer, uri: string, text: string): void {
  server.handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, text, version: 1 } },
  });
}

function change(
  server: SheriffLspServer,
  uri: string,
  text: string,
  version: number,
): void {
  server.handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    },
  });
}

function errorResponse(id: number, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function lastDiagnostics(messages: JsonRpcMessage[]): unknown {
  return (messages.at(-1)?.['params'] as { diagnostics?: unknown })
    ?.diagnostics;
}
