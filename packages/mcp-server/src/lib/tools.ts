import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  callDaemon,
  DaemonBridgeDependencies,
  DaemonCallResult,
} from './daemon-bridge';

/** MCP tool metadata returned by the server's tool-list handler. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties: false;
  };
}

/** JSON Schema property types used by Sheriff tool inputs. */
export interface JsonSchemaProperty {
  type: 'string' | 'boolean';
}

/** Runtime dependencies and project paths used by a tool call. */
export interface ToolCallOptions {
  rootDir: string;
  cliBinPath?: string;
  daemonDependencies?: DaemonBridgeDependencies;
}

/**
 * Text result returned by a Sheriff MCP tool call. Aliased to the SDK's
 * `CallToolResult` so tool handlers structurally satisfy the type expected by
 * `Server.setRequestHandler(CallToolRequestSchema, ...)`.
 */
export type ToolCallResult = CallToolResult;

/** Tool definitions exposed by the Sheriff MCP server. */
export const sheriffTools: McpToolDefinition[] = [
  {
    name: 'verify',
    description: 'Verify the Sheriff module-boundary rules for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        entryFile: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getProjectData',
    description: 'Get the project structure and dependency data from Sheriff.',
    inputSchema: {
      type: 'object',
      properties: {
        entryFile: { type: 'string' },
        includeExternalLibraries: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getConfig',
    description: 'Get the resolved Sheriff configuration.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'lintFile',
    description: 'Check one file for Sheriff rule violations.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        fileContent: { type: 'string' },
      },
      required: ['filename'],
      additionalProperties: false,
    },
  },
];

/** Dispatches an MCP tool call to its corresponding Sheriff daemon RPC. */
export async function handleToolCall(
  name: string,
  args: unknown,
  options: ToolCallOptions,
): Promise<ToolCallResult> {
  try {
    const input = getInputObject(args);
    const daemonCall = createDaemonCall(name, input);
    if (!daemonCall) {
      return createErrorResult(`Unknown Sheriff tool: ${name}`);
    }

    const result = await callDaemon(
      options.rootDir,
      options.cliBinPath,
      daemonCall.method,
      daemonCall.params,
      options.daemonDependencies,
    );
    return formatDaemonResult(result);
  } catch (error) {
    return createErrorResult(getErrorMessage(error));
  }
}

interface DaemonCall {
  method: string;
  params?: Record<string, unknown>;
}

function createDaemonCall(
  name: string,
  input: Record<string, unknown>,
): DaemonCall | undefined {
  switch (name) {
    case 'verify':
      return {
        method: 'verify',
        params: optionalEntryFileParams(input),
      };
    case 'getProjectData':
      return {
        method: 'getProjectData',
        params: {
          ...optionalEntryFileParams(input),
          options: optionalIncludeExternalLibrariesParams(input),
        },
      };
    case 'getConfig':
      return { method: 'getConfig' };
    case 'lintFile':
      return {
        method: 'lintFile',
        params: {
          filename: requiredString(input, 'filename'),
          ...optionalStringParam(input, 'fileContent'),
        },
      };
    default:
      return undefined;
  }
}

function optionalEntryFileParams(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return optionalStringParam(input, 'entryFile');
}

function optionalIncludeExternalLibrariesParams(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const value = input['includeExternalLibraries'];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'boolean') {
    throw new Error('includeExternalLibraries must be a boolean.');
  }
  return { includeExternalLibraries: value };
}

function optionalStringParam(
  input: Record<string, unknown>,
  property: string,
): Record<string, unknown> {
  const value = input[property];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string') {
    throw new Error(`${property} must be a string.`);
  }
  return { [property]: value };
}

function requiredString(
  input: Record<string, unknown>,
  property: string,
): string {
  const value = input[property];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${property} is required and must be a non-empty string.`);
  }
  return value;
}

function getInputObject(args: unknown): Record<string, unknown> {
  if (args === undefined) {
    return {};
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object.');
  }
  return args as Record<string, unknown>;
}

function formatDaemonResult(result: DaemonCallResult): ToolCallResult {
  if (!result.success) {
    return createErrorResult(result.message);
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result.value, null, 2) ?? 'null',
      },
    ],
  };
}

function createErrorResult(message: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
