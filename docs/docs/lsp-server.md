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
repository's `tools/scripts/run-lsp-local.mjs`. Set the working directory to the
project root that contains the TypeScript project and Sheriff configuration.

Under **Mappings | File name patterns**, add `*.ts` / `typescript`, `*.tsx` /
`typescriptreact`, `*.js` / `javascript`, and `*.jsx` / `javascriptreact`. Use
the **File name patterns** tab rather than **Language**: with some
IntelliJ/LSP4IJ combinations, a `TypeScript` language mapping starts and
initializes the server without attaching open files. In that state the server
receives no `textDocument/didOpen` notifications and cannot publish
diagnostics. No initialization options are needed.

After applying the settings, open
`test-projects/angular-iv/src/app/customers/feature/components/customers-container.component.ts`
and temporarily import
`../../../bookings/overview/overview.component`. The **Problems** tool window
should show both a dependency-rule violation and a deep-import violation from
source `sheriff`. These entries have no `ESLint:` prefix; equivalent prefixed
entries can also appear when the Sheriff ESLint rule is enabled. Diagnostics
update from unsaved content.

The default **LSP Consoles | Logs** view is server stdout/stderr and can retain
historical launcher errors. To inspect protocol messages, set **Debug | Trace**
to `verbose`, apply the setting, and close and reopen a mapped file. The trace
should contain `textDocument/didOpen` or `textDocument/didChange`, followed by
`textDocument/publishDiagnostics`. If the server initializes but `didOpen` is
absent, recheck the **File name patterns** mapping. See the package README for
the full local verification and troubleshooting checklist.

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
