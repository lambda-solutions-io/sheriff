# Sheriff MCP Server

`@lambda-solutions/mcp-server-sheriff` is a thin Model Context Protocol
(MCP) server for Sheriff. It gives AI coding agents access to Sheriff through
the existing daemon RPC; all analysis and rule enforcement remains in
`@lambda-solutions/sheriff-core`.

## Configure an MCP client

Add the server to your coding agent's MCP configuration. The snippet below runs
it on demand with `npx`, so no separate install step is required:

```json
{
  "mcpServers": {
    "sheriff": {
      "command": "npx",
      "args": ["@lambda-solutions/mcp-server-sheriff"],
      "env": {
        "SHERIFF_ROOT_DIR": "/abs/path/to/project"
      }
    }
  }
}
```

The bin is named `sheriff-mcp`, but it lives in the scoped package
`@lambda-solutions/mcp-server-sheriff`, so `npx sheriff-mcp` will not resolve.
Use `npx @lambda-solutions/mcp-server-sheriff` (or
`npx --package=@lambda-solutions/mcp-server-sheriff sheriff-mcp`) as above.

Alternatively, install the package locally alongside
`@lambda-solutions/sheriff-core` and reference the installed `sheriff-mcp` bin
directly as the `command`:

```json
{
  "mcpServers": {
    "sheriff": {
      "command": "sheriff-mcp",
      "env": {
        "SHERIFF_ROOT_DIR": "/abs/path/to/project"
      }
    }
  }
}
```

The target project must contain a valid Sheriff configuration. The server
connects to a Sheriff daemon for each tool call and starts one through the
Sheriff CLI when necessary.

## Tools

- `verify`: verifies the project. Accepts an optional string `entryFile`.
- `getProjectData`: returns Sheriff's project and dependency data. Accepts an
  optional string `entryFile` and an optional boolean
  `includeExternalLibraries`.
- `getConfig`: returns the resolved Sheriff configuration. It has no
  parameters.
- `lintFile`: checks a single file. It requires a string `filename` and accepts
  optional string `fileContent` for unsaved file contents.

Tool results are returned as formatted JSON text. Daemon connection and RPC
errors are returned as MCP tool errors.

## Environment variables

- `SHERIFF_ROOT_DIR`: project root used by Sheriff. Defaults to the MCP server
  process's current working directory.
- `SHERIFF_CLI_BIN_PATH`: fallback path to the Sheriff CLI entry point when
  `@lambda-solutions/sheriff-core/src/bin/main.js` cannot be resolved.

`@lambda-solutions/sheriff-core` must be installed and the target project must
have a valid Sheriff configuration.
