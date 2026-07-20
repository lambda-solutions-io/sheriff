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
    changeDebounceMs: 150,
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
    // isolate failures per message so one bad payload cannot drop the
    // remaining messages decoded from the same chunk
    for (const message of reader.push(chunk)) {
      try {
        server.handleMessage(message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Failed to process LSP message: ${text}\n`);
      }
    }
  });
}

main();
