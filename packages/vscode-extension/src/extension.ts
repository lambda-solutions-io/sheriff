import * as vscode from 'vscode';
import { resolveCliBinPath } from './cli-bin-path';
import { SheriffDaemon } from './daemon-connection';
import {
  lintResultToDiagnostics,
  projectEntryToHoverMarkdown,
} from './diagnostics';
import type { PlainDiagnostic } from './diagnostics';

const SUPPORTED_LANGUAGE_IDS = new Set(['typescript', 'typescriptreact']);
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript' },
  { language: 'typescriptreact' },
];
const DEFAULT_DEBOUNCE_MS = 150;

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('sheriff');
  context.subscriptions.push(diagnostics);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  const cliBinPath = resolveCliBinPath(workspaceRoot);
  if (!cliBinPath) {
    void vscode.window.showWarningMessage(
      'Sheriff could not start because @lambda-solutions/sheriff-core is not installed in this workspace.',
    );
    return;
  }

  const daemon = new SheriffDaemon(workspaceRoot, cliBinPath);
  const lintTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const lintDocument = async (document: vscode.TextDocument): Promise<void> => {
    if (!isEnabled(document.uri) || document.isClosed) {
      diagnostics.delete(document.uri);
      return;
    }

    try {
      const result = await daemon.lintFile(
        document.fileName,
        document.getText(),
      );
      if (!result || document.isClosed) {
        return;
      }

      diagnostics.set(
        document.uri,
        lintResultToDiagnostics(result).map(toVscodeDiagnostic),
      );
    } catch (error: unknown) {
      console.error('Sheriff failed to lint the current document.', error);
    }
  };

  const scheduleLint = (document: vscode.TextDocument): void => {
    if (!isSupportedDocument(document)) {
      return;
    }

    const key = document.uri.toString();
    const existingTimer = lintTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (!isEnabled(document.uri)) {
      lintTimers.delete(key);
      diagnostics.delete(document.uri);
      return;
    }

    const timer = setTimeout(() => {
      lintTimers.delete(key);
      void lintDocument(document);
    }, getDebounceMs(document.uri));
    lintTimers.set(key, timer);
  };

  const openListener = vscode.workspace.onDidOpenTextDocument(scheduleLint);
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) =>
    scheduleLint(event.document),
  );
  const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
    const key = document.uri.toString();
    const timer = lintTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      lintTimers.delete(key);
    }
    diagnostics.delete(document.uri);
  });
  const configurationListener = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (!event.affectsConfiguration('sheriff')) {
        return;
      }

      diagnostics.clear();
      for (const document of vscode.workspace.textDocuments) {
        scheduleLint(document);
      }
    },
  );
  const hoverProvider = vscode.languages.registerHoverProvider(
    DOCUMENT_SELECTOR,
    {
      provideHover: async (document): Promise<vscode.Hover | undefined> => {
        if (!isEnabled(document.uri)) {
          return undefined;
        }

        try {
          const projectData = await daemon.getProjectData();
          const markdown = projectEntryToHoverMarkdown(
            projectData?.[document.fileName],
          );
          return markdown
            ? new vscode.Hover(new vscode.MarkdownString(markdown))
            : undefined;
        } catch (error: unknown) {
          console.error('Sheriff failed to provide hover information.', error);
          return undefined;
        }
      },
    },
  );
  const daemonDisposable: vscode.Disposable = {
    dispose: () => {
      for (const timer of lintTimers.values()) {
        clearTimeout(timer);
      }
      lintTimers.clear();
      daemon.dispose();
    },
  };

  context.subscriptions.push(
    openListener,
    changeListener,
    closeListener,
    configurationListener,
    hoverProvider,
    daemonDisposable,
  );

  // Activation can happen after VS Code has already opened the triggering file.
  for (const document of vscode.workspace.textDocuments) {
    scheduleLint(document);
  }
}

export function deactivate(): void {
  // VS Code disposes every item registered in context.subscriptions.
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  // Only real files on disk: the daemon's toFsPath throws for untitled or
  // non-file buffers (git/output/diff schemes), so never lint those.
  return (
    SUPPORTED_LANGUAGE_IDS.has(document.languageId) &&
    document.uri.scheme === 'file' &&
    !document.isUntitled
  );
}

function isEnabled(resource: vscode.Uri): boolean {
  return vscode.workspace
    .getConfiguration('sheriff', resource)
    .get<boolean>('enable', true);
}

function getDebounceMs(resource: vscode.Uri): number {
  const configured = vscode.workspace
    .getConfiguration('sheriff', resource)
    .get<number>('debounceMs', DEFAULT_DEBOUNCE_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DEBOUNCE_MS;
}

function toVscodeDiagnostic(diagnostic: PlainDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(
    diagnostic.line,
    diagnostic.character,
    diagnostic.line,
    diagnostic.endCharacter,
  );
  const result = new vscode.Diagnostic(
    range,
    diagnostic.message,
    vscode.DiagnosticSeverity.Warning,
  );
  result.source = diagnostic.source;
  return result;
}
