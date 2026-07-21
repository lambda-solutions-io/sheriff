---
sidebar_position: 1
title: Introduction
displayed_sidebar: tutorialSidebar
---

**Sheriff** enforces module boundaries and dependency rules in TypeScript.

- **[Module boundaries](./module_boundaries.md)** ensure that files within a module are encapsulated, preventing access from outside the module. Modules are defined either via a `sheriff.config.ts` file or by the presence of a barrel file, like `index.ts`.

- **[Dependency rules](./dependency-rules.md)** allow you to specify which modules can depend on one another, enforcing a clear structure throughout your project. Like module boundaries, these rules are defined in the `sheriff.config.ts` file.

The core package has **zero external dependencies**, with TypeScript as its only peer dependency.

## Why this fork?

This documentation covers a **fork** of [softarc-consulting/sheriff](https://github.com/softarc-consulting/sheriff). The original is created and maintained by [Rainer Hahnekamp](https://github.com/rainerhahnekamp) and the [Softarc Consulting](https://github.com/softarc-consulting) team — the concept, architecture and the vast majority of the code are theirs. If you want the official package, use [`@softarc/sheriff-core`](https://www.npmjs.com/package/@softarc/sheriff-core).

The fork publishes under the `@lambda-solutions` scope and exists to iterate quickly on two things: **stricter architecture rules** and **performance on large codebases**. Additions are strictly additive — existing Sheriff behavior is unchanged — and the goal is to propose the matured ideas upstream.

### Added rule features

- **[`denyRules`](./dependency-rules.md#denyrules)** — forbid dependencies even when `depRules` would otherwise allow them. A matching deny rule wins after `depRules` grants clearance.
- **[`externalRules`](./dependency-rules.md#externalrules)** — restrict which third-party packages a module may import, based on the importing module's tags. Declared-but-uninstalled packages are discovered from the nearest `package.json`, so the check still applies when TypeScript cannot resolve them.
- **[File-level `exports`](./configuration.md#exports)** — define the public API of a barrel-less module explicitly. Wildcards are path-segment local, and `exports` takes precedence over the default `internal` folder convention.
- **[`configs`](./configuration.md#configs)** — use per-directory Sheriff configs in a single workspace, so different areas can carry different module vocabularies and rules.

### Added tooling

- **[Language Server](./lsp-server.md)** — a stdio LSP server that reports violations as editor diagnostics without going through ESLint, for any editor that can start a generic LSP process.
- **Daemon and watch mode** — a per-project background daemon (`sheriff daemon start|stop|status|run`) keeps the analysis warm and serves it over a local socket; `sheriff verify --watch` re-checks on file changes.
- **`verify --files`** — re-check only the files you changed against the cached project graph, which makes Sheriff practical in a pre-commit hook.
- **ESLint daemon bridge** — opt-in (`SHERIFF_DAEMON=1`) reuse of the daemon's warm analysis from the ESLint rules, falling back to in-process analysis if the daemon is unavailable.
- **MCP server** — exposes `verify`, `getProjectData`, `getConfig` and `lintFile` as MCP tools, so agents can query your architecture rules.
- **Plugin commands** — register custom commands that reuse Sheriff's cached project analysis.

### Performance improvements

The original analysis rebuilt most of its work per file, which showed up badly on large projects. Two changes landed:

- **Segment-aware module lookup.** Locating the module that owns a file was an `O(files × modules)` prefix scan. It is now a parent-directory walk against a set of known module paths, which also fixes a latent mismatch where `/a/b` matched `/a/bc/x.ts`.
- **Cached project analysis.** Expensive project setup — config parsing, TypeScript data, module discovery, per-file import resolution — is cached and invalidated by file mtime, with `SHERIFF_NO_CACHE` and `SHERIFF_CACHE_TTL` as escape hatches.

Alongside these, logging became lazy, wildcard rule regexes are memoized, and filesystem probes avoid restatting directory entries.

Measured on synthetic projects (Node 22, Apple Silicon):

| Scenario | Before | After |
| --- | --- | --- |
| `verify`, 10,500 files | 8.4 s | 2.2 s |
| ESLint on `angular-iv` | 2.4 s | 1.3 s |
| `verify` on `angular-iv`, warm daemon | 163 ms (cold) | 5 ms (warm) |

A benchmark harness (`yarn perf:bench`) and a regression suite guard these gains: the committed baseline records a 404.81 ms median for 2,101 files and a 1730.97 ms median for 10,501 files, and `yarn perf:bench:compare` fails on a regression greater than 25%. A separate load-independent check asserts that runtime scales sub-quadratically with project size.

Work in progress on the fork's roadmap includes a Rust analysis engine and further ESLint-path optimizations — see the [Roadmap](./roadmap.md).
