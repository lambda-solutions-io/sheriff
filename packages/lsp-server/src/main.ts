#!/usr/bin/env node
import {
  JsonRpcMessageReader,
  encodeJsonRpcMessage,
} from './lib/message-codec';
import { createSheriffLspServer } from './lib/lsp-server';

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

  const reader = new JsonRpcMessageReader();
  const server = createSheriffLspServer({
    connection: {
      send: (message) => {
        process.stdout.write(encodeJsonRpcMessage(message));
      },
      exit: (code) => {
        process.exit(code);
      },
    },
  });

  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const message of reader.push(chunk)) {
        server.handleMessage(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed to process LSP message: ${message}\n`);
    }
  });
}

main();
