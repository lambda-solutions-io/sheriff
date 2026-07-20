# Sheriff LSP server

`@lambda-solutions/lsp-server-sheriff` exposes Sheriff dependency-rule and
encapsulation violations through the Language Server Protocol. It runs
in-process and communicates over stdio.

The server uses `vscode-languageserver` for the protocol connection and
`vscode-languageserver-textdocument` for incremental document synchronization.
Both packages are runtime dependencies of the published server.

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
  "args": ["tools/scripts/run-lsp-local.mjs", "--stdio"],
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"]
}
```

## IntelliJ

Install the [LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij)
plugin, then open **Settings | Languages & Frameworks | Language Servers** and
add a user-defined server with:

- Name: `Sheriff`
- Command when IntelliJ opened this repository:

  ```text
  node $PROJECT_DIR$/tools/scripts/run-lsp-local.mjs --stdio
  ```

- Command when IntelliJ opened a separate consumer project: use absolute paths
  for both Node and this repository's `tools/scripts/run-lsp-local.mjs`.

In **Mappings | File name patterns**, add:

| Pattern | Language ID       |
| ------- | ----------------- |
| `*.ts`  | `typescript`      |
| `*.tsx` | `typescriptreact` |
| `*.js`  | `javascript`      |
| `*.jsx` | `javascriptreact` |

File-name mappings also work in IntelliJ editions that use TextMate for
TypeScript and preserve that syntax highlighting. No initialization options or
server configuration are required.

Build before starting IntelliJ:

```bash
YARN_IGNORE_PATH=1 corepack yarn install --frozen-lockfile
YARN_IGNORE_PATH=1 corepack yarn build:all
```

`YARN_IGNORE_PATH=1` ensures this Yarn 1 repository is not redirected by a
user-level Yarn 4 configuration.

To verify this checkout, open
`test-projects/angular-iv/src/app/app.component.ts` and temporarily add this
unsaved import:

```ts
import { MessageService } from './shared/ui-messaging/message/message.service';
```

The module specifier should receive a red `sheriff` diagnostic explaining that
it is a deep import. Removing the line should clear the diagnostic without
saving. Use **View | Tool Windows | LSP Consoles** to inspect `initialize`,
`textDocument/didOpen` or `textDocument/didChange`, and
`textDocument/publishDiagnostics` messages. Set the server's trace level to
`verbose` in its **Debug** tab when troubleshooting.

If LSP4IJ cannot find `node`, replace it with the result of `command -v node`.
If the server reports a missing module, rebuild and confirm that both
`dist/packages/lsp-server/src/main.js` and
`dist/packages/lsp-server/src/lib/diagnostics-worker.js` exist. Empty
diagnostics usually mean the opened file has no nearest `tsconfig.json` or no
Sheriff config discoverable from that TypeScript project.

## Performance model

The stdio transport stays responsive while Sheriff performs synchronous
filesystem and TypeScript analysis in one persistent worker thread. Only one
analysis runs at a time, queued revisions of the same URI are coalesced, and
results from older document versions are discarded. A document revision is
analyzed once for dependency, external, and encapsulation rules; the core keeps
at most 16 document analyses and validates their filesystem dependencies before
reuse. Changes are debounced by 150 ms while document-open analysis remains
immediate.

The local launcher creates a temporary module-resolution link to the built core
package, forwards stdio without adding protocol output, and removes the link
when the server exits. Installed releases do not need the launcher; use the
published `sheriff-lsp --stdio` binary directly.

## Protocol

The server handles these document notifications:

- `textDocument/didOpen`
- `textDocument/didChange`
- `textDocument/didClose`

The initialize response advertises incremental text document sync:

```json
{
  "capabilities": {
    "textDocumentSync": 2
  }
}
```

`vscode-languageserver` owns JSON-RPC/LSP framing, initialize and shutdown
lifecycle semantics, request bookkeeping, cancellation, and standard error
responses.

Diagnostics are published with `textDocument/publishDiagnostics`, severity
`Error`, and source `sheriff`. The range covers the module specifier inside the
import or export statement. If the file is outside a TypeScript project or no
`sheriff.config.ts` is found by Sheriff's core project discovery, the server
publishes an empty diagnostics array.

The current implementation uses the same core API as the ESLint plugin from a
persistent worker. A daemon-backed implementation can be added behind the
diagnostics creation function later without changing the LSP transport.
