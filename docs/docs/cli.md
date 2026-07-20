---
sidebar_position: 5
title: CLI
displayed_sidebar: tutorialSidebar
---

The core package (@lambda-solutions/sheriff-core) comes with a CLI to initialize the configuration file, list modules, check the rules and export the dependency graph in JSON format.

## `init`

Run `npx sheriff init` to create a `sheriff.config.ts`. Its configuration runs with [automatic tagging](./dependency-rules#automatic-tagging), meaning no dependency rules are in place, and it only checks for the module boundaries.

## `verify [main.ts]`

Run `npx sheriff verify main.ts` to check if your project violates any of your rules. `main.ts` is in this case the entry file for Sheriff.

See [Entry Files and Entry Points](#entry-files-and-entry-points) for configuration options.

## `verify [main.ts] --files <files>`

Use `npx sheriff verify --files <files>` for one-shot pre-commit and lint-staged hooks. Sheriff checks only the listed changed files against the full project graph, so it skips the per-file check loop over the rest of the project.

A cold one-shot `verify --files` still builds the full project graph (via `init()`) on every run. The sub-second speed-up applies to the warm daemon / `verify --watch` path, where the already-built graph is reused; a cold run mainly saves the per-file checks, not the parse.

It exits with a non-zero status when a listed file violates a rule.

Path handling:

- Requested paths are canonicalized (symlinks resolved, on-disk casing applied) before they are matched against the project graph, so equivalent-but-differently-spelled paths from git or lint-staged still match.
- A file that **does not exist** (deleted/renamed) is skipped with a warning.
- A file that **exists on disk but is not in the project graph** is treated as an **error** (non-zero exit), not a silent skip. In a pre-commit gate this usually signals a resolution problem or a brand-new file that should be wired into the graph.
- Supplying `--files` with an empty list (a bare `--files`, or a substitution matching zero TypeScript files) is a successful no-op — it does **not** fall through to a full-project verification.

Argument order: the optional entry file must come **before** `--files`. Everything after `--files` is treated as a file:

```bash
npx sheriff verify main.ts --files src/app.ts src/shared.ts
```

The file list accepts multiple arguments as well as comma- or space-separated values, and an `--files=` equals form:

```bash
npx sheriff verify --files src/app.ts src/shared.ts
npx sheriff verify --files "src/app.ts,src/shared.ts"
npx sheriff verify --files=src/app.ts,src/shared.ts
```

For example, `.lintstagedrc` can pass lint-staged's changed TypeScript files directly to Sheriff:

```json
{
  "*.ts": "sheriff verify --files"
}
```

`--files` is intended for one-shot hooks. Use `verify --watch` for a long-running process; watch mode already re-analyzes only changed files.

## `list [main.ts]`

Run `npx sheriff list main.ts` to print out all your modules along their tags.

See [Entry Files and Entry Points](#entry-files-and-entry-points) for configuration options.

## `export [main.ts]`

Run `npx sheriff export main.ts > export.json` to export the dependency graph in JSON format. The dependency graph includes all reachable files. For every file, it will include the assigned module as well as the tags.

See [Entry Files and Entry Points](#entry-files-and-entry-points) for configuration options.

## `verify --watch [main.ts]`

Run `npx sheriff verify --watch main.ts` to keep the verification running. Sheriff watches the project for file changes, invalidates only the affected parts of its internal cache, and re-runs the verification — subsequent runs only re-analyze changed files.

## `daemon <start|stop|status>`

Sheriff can run as a background daemon that keeps the parsed project in memory and watches for file changes. Clients (e.g. editor integrations or custom tooling) talk to it over a local socket using newline-delimited JSON-RPC and get instant results because tsconfig parsing, config evaluation, and import resolution stay warm.

- `npx sheriff daemon start` starts (or reuses) the daemon for the current directory.
- `npx sheriff daemon status` prints the daemon's pid and version.
- `npx sheriff daemon stop` shuts it down.

One daemon runs per project root. It exits automatically after 5 minutes without requests (override with `SHERIFF_DAEMON_IDLE_MS`), when its version differs from a connecting client, or when `sheriff.config.ts` changes — the config is evaluated code, so a changed config always gets a fresh process. Clients respawn it on demand.

Available RPC methods: `handshake`, `verify`, `getProjectData`, `getConfig` (function-valued fields are stripped), `lintFile` (accepts unsaved file content), `clearCache`, and `shutdown`.

## Caching

Sheriff caches expensive work (config evaluation, tsconfig parsing, module path scanning, import resolution) in-process, validated via file modification times. Two environment variables control it:

- `SHERIFF_NO_CACHE=1` disables all caching.
- `SHERIFF_CACHE_TTL=<ms>` overrides the staleness window (default 2000ms) for results that depend on directory structure and therefore cannot be validated by file mtimes alone. Under the daemon or `verify --watch`, the file watcher invalidates these exactly instead.

## Plugin Commands

Sheriff can be extended with plugins registered in `sheriff.config.ts`. Plugins are instantiated directly in the config and exposed as additional CLI commands.

```typescript
import { SheriffConfig } from '@lambda-solutions/sheriff-core';
import { JunitReporterPlugin } from 'mberger-junit-sheriff';
import { SheriffUiPlugin } from '@lambda-solutions/sheriff-ui';

export const config: SheriffConfig = {
  modules: {
    'src/feature': 'feature',
    'src/shared': 'shared',
  },
  depRules: {
    feature: 'shared',
  },
  plugins: [
    new SheriffUiPlugin(),
    new JunitReporterPlugin({ junitVersion: 1, reporters: ['html'] }),
  ],
};
```

With this configuration:

```bash
npx sheriff ui
npx sheriff junit report.json
```

### Sheriff UI

`@lambda-solutions/sheriff-ui` serves a live module-graph UI at `http://localhost:7654`. The
page polls the sheriff daemon, whose filesystem watcher keeps the graph current while you edit.
Modules are colored by tag, violations from `verify` are highlighted in red, modules expand to
their files, and external libraries can be toggled in.

```bash
npx sheriff ui                       # serve and open the browser
npx sheriff ui --port 8080 --no-open
npx sheriff ui --entry-file src/main.ts
npx sheriff ui --json                # print one graph snapshot as JSON and exit
```

## Entry Files and Entry Points

Sheriff needs to know where to start traversing your project's imports. You can specify this using either an `entryFile` **or** `entryPoints`.

### Entry File

An entry file is a single file that serves as the starting point for Sheriff's analysis. It's typically your application's main entry point.

Depending on your project, you will likely have a different entry file. For example, with an Angular CLI-based project it would be `src/main.ts`.

**Usage with CLI:**

```bash
npx sheriff verify main.ts
npx sheriff list src/main.ts
npx sheriff export src/main.ts > export.json
```

**Usage with configuration:**
You can set the `entryFile` property in `sheriff.config.ts`:

```typescript
export const config: SheriffConfig = {
  entryFile: './src/main.ts',
  // ... other configuration
};
```

When `entryFile` is set in the configuration, you can omit it from the CLI commands:

```bash
npx sheriff verify
npx sheriff list
npx sheriff export > export.json
```

### Entry Points

Entry points allow you to specify multiple named entry files, useful for workspaces with multiple applications.

**Configuration:**
Define `entryPoints` in `sheriff.config.ts`:

```typescript
export const config: SheriffConfig = {
  entryPoints: {
    'app-web': './apps/web/src/main.ts',
    'app-mobile': './apps/mobile/src/main.ts',
    'app-admin': './apps/admin/src/main.ts',
  },
  // ... other configuration
};
```

**Usage with CLI:**

```bash
# Check specific entry points
npx sheriff verify app-web,app-mobile
npx sheriff list app-admin
npx sheriff export app-web,app-mobile,app-admin > export.json

# If only one entry point is defined, you can omit it
npx sheriff verify
```

### Priority

When both `entryFile` and `entryPoints` are specified in the configuration, Sheriff will throw an error.

CLI arguments take precedence over configuration
