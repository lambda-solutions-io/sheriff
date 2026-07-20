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
  const diagnostics = createWorkerDiagnostics();
  createSheriffLspServer({
    changeDebounceMs: 150,
    connection,
    createDiagnostics: diagnostics.createDiagnostics,
    disposeDiagnostics: diagnostics.dispose,
  });
  connection.listen();
}

main();
