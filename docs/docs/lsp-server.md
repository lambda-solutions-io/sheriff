---
sidebar_position: 7
title: Language Server
displayed_sidebar: tutorialSidebar
---

The Sheriff language server reports dependency-rule and encapsulation
violations as editor diagnostics without using ESLint. It is useful for editors
that can start a generic Language Server Protocol process.

## Start the server

Build Sheriff and start the stdio server:

```bash
sheriff-lsp --stdio
```

`--stdio` is the default and the only supported transport.

## VS Code

Use a generic LSP client extension and configure it to run:

```json
{
  "command": "sheriff-lsp",
  "args": ["--stdio"],
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"]
}
```

When testing from a local checkout, point the client at the built file instead:

```json
{
  "command": "node",
  "args": ["tools/scripts/run-lsp-local.mjs", "--stdio"],
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"]
}
```

## IntelliJ

Install LSP4IJ from the JetBrains Marketplace. In **Settings | Languages &
Frameworks | Language Servers**, add a user-defined server named `Sheriff`.
When IntelliJ opened this repository, use:

```text
node $PROJECT_DIR$/tools/scripts/run-lsp-local.mjs --stdio
```

For a separate consumer project, use absolute paths to Node and the built
repository's `tools/scripts/run-lsp-local.mjs`. Add file-name mappings for
`*.ts` / `typescript`, `*.tsx` / `typescriptreact`, `*.js` / `javascript`, and
`*.jsx` / `javascriptreact`. No initialization options are needed.

After applying the settings, inspect **View | Tool Windows | LSP Consoles**.
Opening or editing a mapped file should show `didOpen` or `didChange`, followed
by `publishDiagnostics`. Diagnostics update from unsaved content. See the
package README for a concrete fixture and troubleshooting checklist.

## Capabilities

The server uses `vscode-languageserver` for the JSON-RPC/LSP connection and
`vscode-languageserver-textdocument` for document state. Both are runtime
dependencies of the published server.

Sheriff handles these document notifications and publishes diagnostics:

- `textDocument/didOpen`
- `textDocument/didChange`
- `textDocument/didClose`
- `textDocument/publishDiagnostics`

The initialize response advertises incremental synchronization with
`textDocumentSync: 2`. The language-server library owns framing, lifecycle
semantics, request bookkeeping, cancellation, and standard protocol errors.

Diagnostics use severity `Error` and source `sheriff`. The diagnostic range
covers the module specifier in the import or export statement. Unsaved editor
content is passed to Sheriff core so `didChange` diagnostics reflect the current
buffer.

Files outside a TypeScript project or without a `sheriff.config.ts` beside the
nearest `tsconfig.json` publish an empty diagnostics list.

Sheriff analysis runs in one persistent worker thread so synchronous project
work cannot block the LSP transport. Queued revisions of the same document are
coalesced, stale results are discarded, changes are debounced by 150 ms, and
all rule families share one bounded, dependency-validated document analysis.
A Sheriff daemon bridge can still be added behind the diagnostics function
later without changing the editor-facing transport.
