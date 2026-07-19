# Sheriff for VS Code

This extension adds Sheriff module-boundary diagnostics and module/tag hover
information to TypeScript and TSX files. It is client glue over Sheriff's daemon
RPC: the extension sends unsaved editor content to `lintFile` and reads project
metadata from `getProjectData`. It does not implement or duplicate lint checks.

## Requirements

- A `sheriff.config.ts` in the opened workspace.
- `@lambda-solutions/sheriff-core` installed in that workspace.
- The Sheriff daemon. The extension starts it automatically when it is not
  already running.

## Development and installation

This extension is intentionally excluded from the repository's default build
(`nx run-many --target=build`, `yarn build:all`, `yarn link:sheriff`) so that
CI does not need `@types/vscode` installed at the repo root. Building it is an
explicit, opt-in step.

Its build type declarations (`@types/vscode`, VS Code packaging tooling) are
declared in this package's `package.json` but are **not** vendored or installed
by the repository. A coordinator building the extension must install them
first — with network access available, run `npm install` in this package
(`packages/vscode-extension`) to obtain `@types/vscode` and `@vscode/vsce`.

Then build it in one of two equivalent ways; both emit `dist/extension.js`,
which is what the manifest's `main` points to:

- `npm run compile` (plain `tsc -p tsconfig.lib.json`), or
- the explicit Nx target `nx build:ext vscode-extension`.

Package it into an installable `.vsix` with `npx vsce package` (runs the
`vscode:prepublish` compile step first). Before publishing, set the `publisher`
field in `package.json` to your marketplace publisher id (it currently defaults
to `lambda-solutions`).

Open the repository in VS Code and press F5 to launch an Extension Development
Host using the compiled extension. The `sheriff.enable` setting controls both
diagnostics and hover, and `sheriff.debounceMs` controls the delay before an
edited document is sent to the daemon.

## Known limitations

- **Multi-entry hover.** Hover metadata is resolved from the first configured
  entry file only (`getProjectData` uses `projectEntries[0]`). In workspaces
  with multiple entry points, hover for files that belong solely to a
  non-primary entry may be missing. Diagnostics are unaffected. Full
  multi-entry hover is a follow-up.
