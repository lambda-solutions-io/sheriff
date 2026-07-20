import {
  Connection,
  Disposable,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createSheriffDiagnostics, Diagnostic } from './diagnostics';

export interface SheriffLspServerOptions {
  /** Connection that owns the JSON-RPC/LSP transport and lifecycle. */
  connection: Connection;
  /** Optional diagnostics implementation, primarily for alternate backends. */
  createDiagnostics?: (
    uri: string,
    text: string,
  ) => Diagnostic[] | Promise<Diagnostic[]>;
  /**
   * Delay before diagnostics run after a document changes, coalescing
   * keystroke storms. Open documents are always analyzed immediately.
   */
  changeDebounceMs?: number;
}

/** The Sheriff-specific state registered on an LSP connection. */
export interface SheriffLspServer {
  /** Incrementally synchronized documents managed by the server. */
  readonly documents: TextDocuments<TextDocument>;
  /** Cancels pending diagnostics and unregisters Sheriff handlers. */
  dispose(): void;
}

/**
 * Registers Sheriff diagnostics and incremental document synchronization on an
 * LSP connection. The caller remains responsible for calling `connection.listen()`.
 */
export function createSheriffLspServer(
  options: SheriffLspServerOptions,
): SheriffLspServer {
  const { connection } = options;
  const createDiagnostics =
    options.createDiagnostics ?? createSheriffDiagnostics;
  const changeDebounceMs = options.changeDebounceMs ?? 0;
  const documents = new TextDocuments(TextDocument);
  const openDocuments = new Set<string>();
  const pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();
  const disposables: Disposable[] = [];

  function sendDiagnosticsSafely(
    uri: string,
    diagnostics: Diagnostic[],
    version?: number,
  ): void {
    try {
      void connection
        .sendDiagnostics({ uri, version, diagnostics })
        .catch(() => undefined);
    } catch {
      // A diagnostics failure must never terminate the language server.
    }
  }

  function publishDiagnostics(document: TextDocument): void {
    try {
      const diagnostics = createDiagnostics(document.uri, document.getText());
      if (diagnostics instanceof Promise) {
        void diagnostics.then(
          (resolvedDiagnostics) =>
            sendDiagnosticsSafely(
              document.uri,
              resolvedDiagnostics,
              document.version,
            ),
          () => sendDiagnosticsSafely(document.uri, [], document.version),
        );
      } else {
        sendDiagnosticsSafely(document.uri, diagnostics, document.version);
      }
    } catch {
      sendDiagnosticsSafely(document.uri, [], document.version);
    }
  }

  function cancelPendingDiagnostics(uri: string): void {
    const pending = pendingDiagnostics.get(uri);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingDiagnostics.delete(uri);
    }
  }

  function scheduleDiagnostics(document: TextDocument): void {
    if (changeDebounceMs <= 0) {
      publishDiagnostics(document);
      return;
    }

    cancelPendingDiagnostics(document.uri);
    const timer = setTimeout(() => {
      pendingDiagnostics.delete(document.uri);
      const latestDocument = documents.get(document.uri);
      if (latestDocument !== undefined) {
        publishDiagnostics(latestDocument);
      }
    }, changeDebounceMs);
    timer.unref?.();
    pendingDiagnostics.set(document.uri, timer);
  }

  disposables.push(
    connection.onInitialize(() => ({
      capabilities: {},
      serverInfo: {
        name: 'sheriff-lsp',
        version: '1.0.0',
      },
    })),
    documents.onDidChangeContent(({ document }) => {
      if (openDocuments.has(document.uri)) {
        scheduleDiagnostics(document);
      } else {
        openDocuments.add(document.uri);
        publishDiagnostics(document);
      }
    }),
    documents.onDidClose(({ document }) => {
      cancelPendingDiagnostics(document.uri);
      openDocuments.delete(document.uri);
      sendDiagnosticsSafely(document.uri, []);
    }),
    documents.listen(connection),
  );

  return {
    documents,
    dispose: () => {
      for (const uri of pendingDiagnostics.keys()) {
        cancelPendingDiagnostics(uri);
      }
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}
