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
  private shutdownRequested = false;

  constructor(options: SheriffLspServerOptions) {
    this.connection = options.connection;
    this.createDiagnostics =
      options.createDiagnostics ?? createSheriffDiagnostics;
  }

  handleMessage(message: JsonRpcMessage): void {
    const method = message['method'];
    if (typeof method !== 'string') {
      return;
    }

    const id = isRequest(message) ? message['id'] : undefined;
    switch (method) {
      case 'initialize':
        this.respond(id, {
          capabilities: {
            textDocumentSync: 1,
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
    const typedParams = params as DidOpenTextDocumentParams;
    const document = typedParams.textDocument;
    this.documents.set(document.uri, document);
    this.publishDiagnostics(document.uri, document.text, document.version);
  }

  private didChange(params: unknown): void {
    const typedParams = params as DidChangeTextDocumentParams;
    const change = typedParams.contentChanges.at(-1);
    if (!change) {
      return;
    }

    const existingDocument = this.documents.get(typedParams.textDocument.uri);
    const document = {
      uri: typedParams.textDocument.uri,
      text: change.text,
      version: typedParams.textDocument.version,
    };
    this.documents.set(document.uri, {
      ...existingDocument,
      ...document,
    });
    this.publishDiagnostics(document.uri, document.text, document.version);
  }

  private didSave(params: unknown): void {
    const typedParams = params as DidSaveTextDocumentParams;
    const uri = typedParams.textDocument.uri;
    const existingDocument = this.documents.get(uri);
    const text = typedParams.text ?? existingDocument?.text ?? readFile(uri);
    if (text === undefined) {
      this.publishDiagnostics(uri, '', existingDocument?.version);
      return;
    }

    this.documents.set(uri, {
      uri,
      text,
      version: existingDocument?.version,
    });
    this.publishDiagnostics(uri, text, existingDocument?.version);
  }

  private didClose(params: unknown): void {
    const typedParams = params as DidCloseTextDocumentParams;
    const uri = typedParams.textDocument.uri;
    this.documents.delete(uri);
    this.sendDiagnostics(uri, []);
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
