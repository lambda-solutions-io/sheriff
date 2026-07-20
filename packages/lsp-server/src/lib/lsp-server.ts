import { existsSync, readFileSync } from 'fs';
import { JsonRpcMessage } from './message-codec';
import { createSheriffDiagnostics, Diagnostic } from './diagnostics';
import { uriToFilePath } from './uri';

export interface LspConnection {
  send(message: JsonRpcMessage): void;
  exit(code: number): void;
}

export interface SheriffLspServerOptions {
  connection: LspConnection;
  createDiagnostics?: (
    uri: string,
    text: string,
  ) => Diagnostic[] | Promise<Diagnostic[]>;
  /**
   * Delay before diagnostics run after didChange, coalescing keystroke
   * storms. 0 (default) publishes synchronously — used by tests; main.ts
   * wires a real delay.
   */
  changeDebounceMs?: number;
}

interface TextDocumentItem {
  uri: string;
  text: string;
  version?: number | null;
}

interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

interface DidChangeTextDocumentParams {
  textDocument: {
    uri: string;
    version?: number | null;
  };
  contentChanges: { text: string }[];
}

interface DidSaveTextDocumentParams {
  textDocument: {
    uri: string;
  };
  text?: string;
}

interface DidCloseTextDocumentParams {
  textDocument: {
    uri: string;
  };
}

type RequestId = string | number | null;
type ServerState = 'uninitialized' | 'initialized' | 'shutdown';

export class SheriffLspServer {
  private readonly connection: LspConnection;
  private readonly createDiagnostics: (
    uri: string,
    text: string,
  ) => Diagnostic[] | Promise<Diagnostic[]>;
  private readonly documents = new Map<string, TextDocumentItem>();
  private readonly pendingDiagnostics = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly changeDebounceMs: number;
  private state: ServerState = 'uninitialized';

  constructor(options: SheriffLspServerOptions) {
    this.connection = options.connection;
    this.createDiagnostics =
      options.createDiagnostics ?? createSheriffDiagnostics;
    this.changeDebounceMs = options.changeDebounceMs ?? 0;
  }

  handleMessage(message: JsonRpcMessage): void {
    const request = isRequest(message);
    const method = message['method'];
    if (typeof method !== 'string') {
      if (request) {
        this.sendError(message['id'], -32600, 'Invalid Request');
      }
      return;
    }

    const id = request ? message['id'] : undefined;
    try {
      this.dispatch(method, id, message);
    } catch (error) {
      if (id !== undefined) {
        this.connection.send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private dispatch(
    method: string,
    id: RequestId | undefined,
    message: JsonRpcMessage,
  ): void {
    const request = id !== undefined;
    if (method === 'exit' && !request) {
      this.connection.exit(this.state === 'shutdown' ? 0 : 1);
      return;
    }

    if (this.state === 'uninitialized') {
      if (method === 'initialize' && request) {
        this.state = 'initialized';
        this.respond(id, {
          capabilities: {
            textDocumentSync: {
              openClose: true,
              change: 1,
              save: { includeText: true },
            },
          },
          serverInfo: {
            name: 'sheriff-lsp',
            version: '1.0.0',
          },
        });
      } else if (request) {
        this.sendError(id, -32002, 'Server not initialized');
      }
      return;
    }

    if (this.state === 'shutdown') {
      if (request) {
        this.sendError(id, -32600, 'Invalid Request');
      }
      return;
    }

    switch (method) {
      case 'initialize':
      case 'initialized':
      case 'exit':
        if (request) {
          this.sendError(id, -32600, 'Invalid Request');
        }
        break;
      case 'shutdown':
        if (request) {
          this.state = 'shutdown';
          this.respond(id, null);
        }
        break;
      case 'textDocument/didOpen':
      case 'textDocument/didChange':
      case 'textDocument/didSave':
      case 'textDocument/didClose':
        if (request) {
          this.sendError(id, -32600, 'Invalid Request');
          break;
        }
        if (method === 'textDocument/didOpen') {
          this.didOpen(message['params']);
        } else if (method === 'textDocument/didChange') {
          this.didChange(message['params']);
        } else if (method === 'textDocument/didSave') {
          this.didSave(message['params']);
        } else {
          this.didClose(message['params']);
        }
        break;
      default:
        if (request) {
          this.sendError(id, -32601, `Method not found: ${method}`);
        }
    }
  }

  private didOpen(params: unknown): void {
    const typedParams = params as Partial<DidOpenTextDocumentParams>;
    const document = typedParams?.textDocument;
    if (
      typeof document?.uri !== 'string' ||
      typeof document.text !== 'string'
    ) {
      return;
    }
    this.documents.set(document.uri, document);
    this.publishDiagnostics(document.uri, document.text, document.version);
  }

  private didChange(params: unknown): void {
    const typedParams = params as Partial<DidChangeTextDocumentParams>;
    const uri = typedParams?.textDocument?.uri;
    const change = Array.isArray(typedParams?.contentChanges)
      ? typedParams.contentChanges.at(-1)
      : undefined;
    if (typeof uri !== 'string' || typeof change?.text !== 'string') {
      return;
    }

    const existingDocument = this.documents.get(uri);
    if (!existingDocument) {
      return;
    }
    const document = {
      uri,
      text: change.text,
      version: typedParams?.textDocument?.version,
    };
    this.documents.set(document.uri, { ...existingDocument, ...document });
    this.schedulePublishDiagnostics(
      document.uri,
      document.text,
      document.version,
    );
  }

  private didSave(params: unknown): void {
    const typedParams = params as Partial<DidSaveTextDocumentParams>;
    const uri = typedParams?.textDocument?.uri;
    if (typeof uri !== 'string') {
      return;
    }
    const existingDocument = this.documents.get(uri);
    const text = typedParams.text ?? existingDocument?.text ?? readFile(uri);
    if (text === undefined) {
      this.publishDiagnostics(uri, '', existingDocument?.version);
      return;
    }

    this.cancelPendingDiagnostics(uri);
    this.documents.set(uri, {
      uri,
      text,
      version: existingDocument?.version,
    });
    this.publishDiagnostics(uri, text, existingDocument?.version);
  }

  private didClose(params: unknown): void {
    const typedParams = params as Partial<DidCloseTextDocumentParams>;
    const uri = typedParams?.textDocument?.uri;
    if (typeof uri !== 'string') {
      return;
    }
    this.cancelPendingDiagnostics(uri);
    this.documents.delete(uri);
    this.sendDiagnosticsSafely(uri, []);
  }

  private schedulePublishDiagnostics(
    uri: string,
    text: string,
    version?: number | null,
  ): void {
    if (this.changeDebounceMs <= 0) {
      this.publishDiagnostics(uri, text, version);
      return;
    }

    this.cancelPendingDiagnostics(uri);
    const timer = setTimeout(() => {
      try {
        this.pendingDiagnostics.delete(uri);
        // publish the latest stored text, not the captured one, in case
        // didSave updated the document while the timer was pending
        const document = this.documents.get(uri);
        if (document) {
          this.publishDiagnostics(uri, document.text, document.version);
        }
      } catch {
        this.sendDiagnosticsSafely(uri, [], version);
      }
    }, this.changeDebounceMs);
    timer.unref?.();
    this.pendingDiagnostics.set(uri, timer);
  }

  private cancelPendingDiagnostics(uri: string): void {
    const pending = this.pendingDiagnostics.get(uri);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingDiagnostics.delete(uri);
    }
  }

  private publishDiagnostics(
    uri: string,
    text: string,
    version?: number | null,
  ): void {
    try {
      const diagnostics = this.createDiagnostics(uri, text);
      if (diagnostics instanceof Promise) {
        void diagnostics.then(
          (resolvedDiagnostics) =>
            this.sendDiagnosticsSafely(uri, resolvedDiagnostics, version),
          () => this.sendDiagnosticsSafely(uri, [], version),
        );
      } else {
        this.sendDiagnosticsSafely(uri, diagnostics, version);
      }
    } catch {
      this.sendDiagnosticsSafely(uri, [], version);
    }
  }

  private sendDiagnosticsSafely(
    uri: string,
    diagnostics: Diagnostic[],
    version?: number | null,
  ): void {
    try {
      this.connection.send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          version,
          diagnostics,
        },
      });
    } catch {
      // A diagnostics failure must never terminate the stdio server.
    }
  }

  private respond(id: RequestId | undefined, result: unknown): void {
    if (id === undefined) {
      return;
    }

    this.connection.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  private sendError(id: RequestId, code: number, message: string): void {
    this.connection.send({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }
}

export function createSheriffLspServer(
  options: SheriffLspServerOptions,
): SheriffLspServer {
  return new SheriffLspServer(options);
}

function isRequest(message: JsonRpcMessage): message is JsonRpcMessage & {
  id: RequestId;
} {
  return Object.hasOwn(message, 'id');
}

function readFile(uri: string): string | undefined {
  try {
    const filePath = uriToFilePath(uri);
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
