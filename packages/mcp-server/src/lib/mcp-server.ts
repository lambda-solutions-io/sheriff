import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DaemonBridgeDependencies,
  resolveSheriffCliBinPath,
} from './daemon-bridge';
import { handleToolCall, sheriffTools } from './tools';

/** Configuration overrides for a Sheriff MCP server instance. */
export interface SheriffMcpServerOptions {
  rootDir?: string;
  cliBinPath?: string;
  daemonDependencies?: DaemonBridgeDependencies;
}

/** Creates an MCP server configured with the Sheriff daemon-backed tools. */
export function createSheriffMcpServer(
  options: SheriffMcpServerOptions = {},
): Server {
  const rootDir =
    options.rootDir ?? process.env['SHERIFF_ROOT_DIR'] ?? process.cwd();
  const cliBinPath = options.cliBinPath ?? resolveSheriffCliBinPath();
  const server = new Server(
    {
      name: 'sheriff-mcp',
      version: '1.0.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: sheriffTools,
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handleToolCall(request.params.name, request.params.arguments, {
      rootDir,
      cliBinPath,
      daemonDependencies: options.daemonDependencies,
    }),
  );

  return server;
}
