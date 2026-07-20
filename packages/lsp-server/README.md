# Sheriff LSP server

`@lambda-solutions/lsp-server-sheriff` exposes Sheriff dependency-rule and
encapsulation violations through the Language Server Protocol. It runs
in-process and communicates over stdio using JSON-RPC 2.0 framing.

## Usage

Build the package and point an editor LSP client at the `sheriff-lsp` binary:

```bash
sheriff-lsp --stdio
```

`--stdio` is the default and the only transport currently supported.

## VS Code

Use a generic LSP client extension and configure it to start the Sheriff server
with stdio. The exact setting names depend on the extension, but the command
shape is:

```json
{
  "command": "sheriff-lsp",
  "args": ["--stdio"],
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"]
}
```

For local development from this repository, use the built binary:

```json
{
  "command": "node",
  "args": ["dist/packages/lsp-server/src/main.js", "--stdio"],
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"]
}
```

## IntelliJ

IntelliJ Platform 2023.2 and newer can host native LSP integrations. For IDEs
without a dedicated Sheriff integration, LSP4IJ can start the same stdio
command:

```text
node dist/packages/lsp-server/src/main.js --stdio
```

Map the server to TypeScript and JavaScript file types in the project that has
`tsconfig.json` and `sheriff.config.ts` at the TypeScript project root.

## Protocol

The server implements these LSP methods:

- `initialize`
- `initialized`
- `shutdown`
- `exit`
- `textDocument/didOpen`
- `textDocument/didChange`
- `textDocument/didSave`
- `textDocument/didClose`

The initialize response advertises full text document sync:

```json
{
  "capabilities": {
    "textDocumentSync": 1
  }
}
```

Diagnostics are published with `textDocument/publishDiagnostics`, severity
`Error`, and source `sheriff`. The range covers the module specifier inside the
import or export statement. If the file is outside a TypeScript project or no
`sheriff.config.ts` is found by Sheriff's core project discovery, the server
publishes an empty diagnostics array.

Messages use standard LSP stdio framing:

```text
Content-Length: <utf8-byte-length>\r\n
\r\n
<json-rpc-message>
```

The current implementation uses the same in-process core API as the ESLint
plugin. A daemon-backed implementation can be added behind the diagnostics
creation function later without changing the LSP transport.

## Known limitations

- Files that use lone carriage returns (`\r`) as line endings are unsupported.
  Use LF (`\n`) or CRLF (`\r\n`) so diagnostic line and character positions
  match the editor document.
