---
title: Roadmap
displayed_sidebar: roadmapSidebar
---

# Roadmap

## Towards v1

In order to reach version 1, we plan to add following features

- ✅ ESLint flat config
- ✅ Barrel-less modules: It should be possible to define encapsulation without an _index.ts_. This is because barrel files cause a problem for any code-splitting/tree-shaking process. We plan to provide following alternatives to the barrel file:
  - _internal_ folder
  - folder/files with `_` prefix
  - decorators @private/@public
- ✅ optional cache: For large applications we require a cache together with a background process that watches the filesystem and updates the cache. Shipped in this fork: project analysis is cached with mtime-based invalidation, and a per-project daemon keeps it warm and watches the filesystem. Opt out with `SHERIFF_NO_CACHE`.
- ☑️ Angular schematic: For Angular application, there will be a migration available that allows to update Sheriff via `ng update`, and install it via `ng add @softarc/ng-sheriff`.

## Future plans

- ESLint for _sheriff.config.ts_: Sheriff should be able to verify if the configuration with tagging and module definition is valid, in that sense if the defined directories actually exist.
- Config API: Explore ways on how to improve the configuration file. Could be done via providing a fluent API, that provides better type-safety and DX.
- Mixed-config project graphs: Resolve config, module vocabulary, and rules per file when one import traversal crosses directories mapped by `configs`. Separate entry points already select separate configs.
- UI: Visualization of the dependencies with live-tracking of the dependency rules' impact.
- ✅ Excluding third-party libraries: Restrict third-party imports per module tag with `externalRules`.
- ✅ External dependency discovery: Read the nearest package manifest to classify declared but uninstalled packages for `externalRules`.
- External dependency validation: Validate external rules against declared packages and warn about unlisted dependencies.
- Nx Interop: Allow Sheriff to consume Nx dependency rules.
- Quality metrics: Extend Sheriff by adding various quality metrics which run next to the dependency rules.
- Tutorial/Playground in the Docs: Provide a tutorial with WebContainers
- API Documentation

## Fork status

The items below are specific to this fork. See [Why this fork?](./introduction.md#why-this-fork) for what the fork adds and why.

### Shipped

- ✅ Stricter architecture rules: `denyRules`, `externalRules`, file-level module `exports`, and per-directory `configs`.
- ✅ Performance on large codebases: segment-aware module lookup and a cached project analysis brought `verify` on 10,500 files from 8.4 s to 2.2 s, with a benchmark harness and regression guards to hold the gain.
- ✅ Background process: a per-project daemon with `verify --watch`, plus `verify --files` for incremental pre-commit checks.
- ✅ Editor integration without ESLint: a stdio [Language Server](./lsp-server.md) publishing violations as diagnostics.
- ✅ MCP server: exposes Sheriff's analysis to agent tooling.
- ✅ Plugin commands: custom commands that reuse the cached project analysis.

### In progress

These live on feature branches and are not part of a release yet.

- Rust analysis engine: move filesystem traversal, import extraction, module resolution and the static rule checks into a native engine, keeping config evaluation and function-valued rules in Node. Opt-in behind a flag, with per-project fallback to the TypeScript path whenever the engine cannot serve a project. Early measurements are promising, but parity with the TypeScript implementation is the gating requirement, not raw speed.
- ESLint path optimizations: share a single analysis across rules for the same file, and cache the module skeleton across linted files. The ESLint path is currently the slowest way to run Sheriff on a large project.
- Reporters: JSON and JUnit XML output for CI consumption, regenerated on every watch-mode re-verify.
- VS Code extension: a client over the daemon RPC, with diagnostics on edit and module/tag hovers.
- Multiple entry points: analyze several entry points from a single configuration.
