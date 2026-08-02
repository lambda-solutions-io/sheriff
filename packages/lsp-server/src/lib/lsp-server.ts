import {
  Connection,
  Disposable,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createSheriffDiagnostics, Diagnostic } from './diagnostics';
import { isFileUri } from './uri';
import { isDiagnosticsSupersededError } from './worker-diagnostics';

export interface SheriffLspServerOptions {
  /** Connection that owns the JSON-RPC/LSP transport and lifecycle. */
  connection: Connection;
  /** Optional diagnostics implementation, primarily for alternate backends. */
  createDiagnostics?: (
    uri: string,
    text: string,
  ) => Diagnostic[] | Promise<Diagnostic[]>;
  /** Releases resources owned by the diagnostics implementation. */
  disposeDiagnostics?: () => void;
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

type ServerState =
  | 'uninitialized'
  | 'initializing'
  | 'initialized'
  | 'shutdown';

const MAX_INITIALIZING_DOCUMENTS = 1_000;

interface DiagnosticsRun {
  readonly uri: string;
  readonly version: number;
  readonly documentGeneration: number;
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
  const documentGenerations = new Map<string, number>();
  const pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlightDiagnostics = new Set<DiagnosticsRun>();
  const initializingDocuments = new Set<string>();
  const disposables: Disposable[] = [];
  let state: ServerState = 'uninitialized';
  let diagnosticsDisposed = false;

  function disposeDiagnostics(): void {
    if (diagnosticsDisposed) {
      return;
    }
    diagnosticsDisposed = true;
    try {
      options.disposeDiagnostics?.();
    } catch {
      // Resource cleanup must not break the LSP shutdown lifecycle.
    }
  }

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

  function reportDiagnosticsFailure(uri: string, error: unknown): void {
    try {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(
        `Sheriff diagnostics failed for ${uri}: ${message}`,
      );
    } catch {
      // Error reporting must never terminate the language server.
    }
  }

  function isCurrentDiagnosticsRun(run: DiagnosticsRun): boolean {
    return (
      state === 'initialized' &&
      inFlightDiagnostics.has(run) &&
      openDocuments.has(run.uri) &&
      documentGenerations.get(run.uri) === run.documentGeneration &&
      documents.get(run.uri)?.version === run.version
    );
  }

  function finishDiagnosticsRun(
    run: DiagnosticsRun,
    diagnostics: Diagnostic[],
  ): void {
    const shouldPublish = isCurrentDiagnosticsRun(run);
    inFlightDiagnostics.delete(run);
    if (shouldPublish) {
      sendDiagnosticsSafely(run.uri, diagnostics, run.version);
    }
  }

  function publishDiagnostics(document: TextDocument): void {
    const uri = document.uri;
    const text = document.getText();
    const version = document.version;
    const run: DiagnosticsRun = {
      uri,
      version,
      documentGeneration: documentGenerations.get(uri) ?? 0,
    };
    inFlightDiagnostics.add(run);

    try {
      const diagnostics = createDiagnostics(uri, text);
      if (diagnostics instanceof Promise) {
        void diagnostics.then(
          (resolvedDiagnostics) =>
            finishDiagnosticsRun(run, resolvedDiagnostics),
          (error) => {
            // Routine coalescing is neither a failure nor worth logging.
            if (isDiagnosticsSupersededError(error)) {
              inFlightDiagnostics.delete(run);
              return;
            }
            // Fail closed: keep the last published diagnostics instead of
            // clearing every squiggle when analysis breaks (#44).
            inFlightDiagnostics.delete(run);
            reportDiagnosticsFailure(uri, error);
          },
        );
      } else {
        finishDiagnosticsRun(run, diagnostics);
      }
    } catch (error) {
      inFlightDiagnostics.delete(run);
      reportDiagnosticsFailure(uri, error);
    }
  }

  function invalidateDocumentDiagnostics(uri: string): void {
    documentGenerations.set(uri, (documentGenerations.get(uri) ?? 0) + 1);
    for (const run of inFlightDiagnostics) {
      if (run.uri === uri) {
        inFlightDiagnostics.delete(run);
      }
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

  function diagnoseChangedDocument(document: TextDocument): void {
    if (!isFileUri(document.uri)) {
      // Untitled buffers and scheme views (git:, vscode-userdata:) have no
      // on-disk module, so they must never reach the diagnostics backend.
      return;
    }
    invalidateDocumentDiagnostics(document.uri);
    if (openDocuments.has(document.uri)) {
      scheduleDiagnostics(document);
    } else {
      openDocuments.add(document.uri);
      publishDiagnostics(document);
    }
  }

  function queueInitializingDocument(uri: string): void {
    // Queue eager clients until `initialized`; the cap bounds invalid traffic.
    if (initializingDocuments.size < MAX_INITIALIZING_DOCUMENTS) {
      initializingDocuments.add(uri);
    }
  }

  function flushInitializingDocuments(): void {
    const uris = [...initializingDocuments];
    initializingDocuments.clear();
    for (const uri of uris) {
      const document = documents.get(uri);
      if (document !== undefined) {
        diagnoseChangedDocument(document);
      }
    }
  }

  function cancelAllDiagnostics(): void {
    for (const pending of pendingDiagnostics.values()) {
      clearTimeout(pending);
    }
    pendingDiagnostics.clear();
    inFlightDiagnostics.clear();
    openDocuments.clear();
    documentGenerations.clear();
    initializingDocuments.clear();
  }

  disposables.push(
    connection.onInitialize(() => {
      if (state === 'uninitialized') {
        state = 'initializing';
      }
      return {
        capabilities: {},
        serverInfo: {
          name: 'sheriff-lsp',
          version: '1.0.0',
        },
      };
    }),
    connection.onInitialized(() => {
      if (state === 'initializing') {
        state = 'initialized';
        flushInitializingDocuments();
      }
    }),
    connection.onShutdown(() => {
      state = 'shutdown';
      cancelAllDiagnostics();
      disposeDiagnostics();
    }),
    documents.onDidChangeContent(({ document }) => {
      if (state === 'initializing') {
        queueInitializingDocument(document.uri);
        return;
      }
      if (state !== 'initialized') {
        return;
      }

      diagnoseChangedDocument(document);
    }),
    documents.onDidClose(({ document }) => {
      if (state === 'initializing') {
        initializingDocuments.delete(document.uri);
        return;
      }
      if (state !== 'initialized') {
        return;
      }

      cancelPendingDiagnostics(document.uri);
      openDocuments.delete(document.uri);
      invalidateDocumentDiagnostics(document.uri);
      documentGenerations.delete(document.uri);
      sendDiagnosticsSafely(document.uri, []);
    }),
    documents.listen(connection),
  );

  return {
    documents,
    dispose: () => {
      state = 'shutdown';
      cancelAllDiagnostics();
      disposeDiagnostics();
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}
