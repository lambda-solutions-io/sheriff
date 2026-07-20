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
  createDiagnostics?: (uri: string, text: string) => Diagnostic[];
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

export class SheriffLspServer {
  private readonly connection: LspConnection;
  private readonly createDiagnostics: (
    uri: string,
    text: string,
  ) => Diagnostic[];
  private readonly documents = new Map<string, TextDocumentItem>();
  private readonly pendingDiagnostics = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly changeDebounceMs: number;
  private shutdownRequested = false;

  constructor(options: SheriffLspServerOptions) {
    this.connection = options.connection;
    this.createDiagnostics =
      options.createDiagnostics ?? createSheriffDiagnostics;
    this.changeDebounceMs = options.changeDebounceMs ?? 0;
  }

  handleMessage(message: JsonRpcMessage): void {
    const method = message['method'];
    if (typeof method !== 'string') {
      return;
    }

    const id = isRequest(message) ? message['id'] : undefined;
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
    switch (method) {
      case 'initialize':
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
        break;
      case 'initialized':
        break;
      case 'shutdown':
        this.shutdownRequested = true;
        this.respond(id, null);
        break;
      case 'exit':
        this.connection.exit(this.shutdownRequested ? 0 : 1);
        break;
      case 'textDocument/didOpen':
        this.didOpen(message['params']);
        break;
      case 'textDocument/didChange':
        this.didChange(message['params']);
        break;
      case 'textDocument/didSave':
        this.didSave(message['params']);
        break;
      case 'textDocument/didClose':
        this.didClose(message['params']);
        break;
      default:
        if (id !== undefined) {
          this.connection.send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
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
    const document = {
      uri,
      text: change.text,
      version: typedParams?.textDocument?.version,
    };
    this.documents.set(document.uri, {
      ...existingDocument,
      ...document,
    });
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
    this.sendDiagnostics(uri, []);
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
      this.pendingDiagnostics.delete(uri);
      // publish the latest stored text, not the captured one, in case
      // didSave updated the document while the timer was pending
      const document = this.documents.get(uri);
      if (document) {
        this.publishDiagnostics(uri, document.text, document.version);
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
    const diagnostics = this.createDiagnostics(uri, text);
    this.sendDiagnostics(uri, diagnostics, version);
  }

  private sendDiagnostics(
    uri: string,
    diagnostics: Diagnostic[],
    version?: number | null,
  ): void {
    this.connection.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        version,
        diagnostics,
      },
    });
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
