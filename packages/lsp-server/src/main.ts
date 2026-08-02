#!/usr/bin/env node
import { createConnection } from 'vscode-languageserver/node';
import { createSheriffLspServer } from './lib/lsp-server';
import { createWorkerDiagnostics } from './lib/worker-diagnostics';

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: sheriff-lsp [--stdio]\n');
    return;
  }

  const unsupportedArg = args.find((arg) => arg !== '--stdio');
  if (unsupportedArg) {
    process.stderr.write(`Unsupported argument: ${unsupportedArg}\n`);
    process.exitCode = 1;
    return;
  }

  const connection = createConnection(process.stdin, process.stdout);
  let workerFailureNotified = false;
  const diagnostics = createWorkerDiagnostics({
    onWorkerFailure: (error) => {
      // Surface every crash in the log, but pop up at most one editor
      // notification so repeated crashes do not spam the user. A disposed
      // connection throws synchronously, so guard the whole notify block.
      try {
        connection.console.error(
          `Sheriff diagnostics worker crashed: ${error.message}`,
        );
        if (!workerFailureNotified) {
          workerFailureNotified = true;
          void connection.window.showErrorMessage(
            `Sheriff diagnostics worker crashed: ${error.message}`,
          );
        }
      } catch {
        // Crash reporting must never break worker supervision.
      }
    },
  });
  createSheriffLspServer({
    changeDebounceMs: 150,
    connection,
    createDiagnostics: diagnostics.createDiagnostics,
    disposeDiagnostics: diagnostics.dispose,
  });
  connection.listen();
}

main();
