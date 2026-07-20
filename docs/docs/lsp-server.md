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
  "args": ["dist/packages/lsp-server/src/main.js", "--stdio"],
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"]
}
```

## IntelliJ

IntelliJ Platform 2023.2 and newer includes an LSP API. If your IDE does not
ship a Sheriff integration, use LSP4IJ and configure it to start:

```text
node dist/packages/lsp-server/src/main.js --stdio
```

Attach the server to TypeScript and JavaScript file types in a project that has
`tsconfig.json` and `sheriff.config.ts` at the TypeScript project root.

## Capabilities

The server currently implements:

- `initialize` with `textDocumentSync: 1`
- `initialized`
- `shutdown`
- `exit`
- `textDocument/didOpen`
- `textDocument/didChange`
- `textDocument/didSave`
- `textDocument/didClose`
- `textDocument/publishDiagnostics`

Diagnostics use severity `Error` and source `sheriff`. The diagnostic range
covers the module specifier in the import or export statement. Unsaved editor
content is passed to Sheriff core so `didChange` diagnostics reflect the current
buffer.

Files outside a TypeScript project or without a `sheriff.config.ts` beside the
nearest `tsconfig.json` publish an empty diagnostics list.

## Stdio contract

The transport is plain JSON-RPC 2.0 over stdio with LSP headers:

```text
Content-Length: <utf8-byte-length>\r\n
\r\n
<json-rpc-message>
```

The implementation is intentionally in-process today. A Sheriff daemon bridge
can be added behind the diagnostics creation function later without changing
the editor-facing LSP transport.
