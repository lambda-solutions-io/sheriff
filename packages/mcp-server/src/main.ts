#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSheriffMcpServer } from './lib/mcp-server';

async function main(): Promise<void> {
  const server = createSheriffMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  registerShutdownHandlers(server);
}

function registerShutdownHandlers(
  server: ReturnType<typeof createSheriffMcpServer>,
): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void server
      .close()
      .catch(() => undefined)
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start the Sheriff MCP server: ${message}`);
  process.exitCode = 1;
});
