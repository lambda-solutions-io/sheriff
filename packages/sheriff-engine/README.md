# Sheriff Rust engine

The native engine accepts the versioned JSON shape declared in `index.d.ts`. Invalid regular
expressions and resource-limit violations are returned as structured engine errors; the N-API
boundary never intentionally panics for user configuration. Tag matcher regular expressions use
JavaScript's first, leftmost match and only match when that first match is the complete segment.

## Rollback / opt-in

The Rust engine is opt-in: set `SHERIFF_ENGINE=1` to enable it. With the variable unset, Sheriff
uses the TypeScript implementation by default. Unsupported configuration, an impure callback, a
missing native package, or any engine error automatically falls back to TypeScript for the affected
project or request. Set `SHERIFF_ENGINE_DEBUG=1` to print each fallback and its reason. To fully
disable the engine, unset `SHERIFF_ENGINE`; no rebuild is required.

## Native packaging

Run the local build from the repository root:

```bash
node packages/sheriff-engine/scripts/build-native.mjs
```

This invokes `@napi-rs/cli` with Cargo offline and writes the local addon plus
the generated raw loader to `native/`. The public `index.js` remains the
hand-written compatibility boundary; it imports `native/binding.js`, while the
generated `native/binding.d.ts` intentionally describes only the raw string
JSON API. The rich public types remain in `index.d.ts`.

`napi create-npm-dirs` owns the checked-in `npm/<triple>` package stubs. The
root package declares each stub as an optional dependency at the same version,
and the generated binding tries a local addon before its matching platform
package. `.github/workflows/sheriff-engine-prebuilds.yml` builds all supported
targets, runs `napi artifacts` to populate the stubs, and can publish the
platform packages before the JavaScript wrapper package. The workflow also
emits `SHA256SUMS`; `@napi-rs/cli` 3.7.4 has no package-checksum configuration
of its own.

## Input limits

These limits keep malformed configuration from exhausting the Node host process:

- input JSON: 64 MiB
- files and module paths: 100,000 each
- imports: 1,000,000 total
- rule entries/matchers and tag configuration entries: 100,000 each
- generated/configured tags: 100,000
- paths and other user strings: 16 KiB each
- regular expression source: 4 KiB
- module configuration, placeholder, and regular expression nesting: 64 levels
- fancy-regex backtracking: 1,000,000 steps; delegated regex programs: 4 MiB

JavaScript `RegExp` values are serialized as `{ source, flags }` only for
`encapsulationPattern`. Sticky (`y`) and Unicode-set (`v`) flags are rejected with a structured
error because approximating either at the stateless JSON boundary would be incorrect.

## Function callback materialization

The JavaScript bridge batches only reachable callbacks whose source has no free identifiers.
The TypeScript compiler parses `Function.prototype.toString()` output and resolves lexical symbols
to distinguish parameter and local bindings from closures, imports, and ambient globals.
Destructured and nested parameters are supported; non-computed property names and string literals
are not references.
Native/opaque functions, unsupported source forms, `this`, `super`, `import.meta`, `new.target`,
and every unresolved identifier cause `SHERIFF_ENGINE_IMPURE_CALLBACK` fallback before the
callback is invoked. A named callback that references its own binding is also rejected because
properties on that function can retain mutable state across calls.

This lexical gate cannot prove that calls made through a parameter are side-effect-free, nor can
it detect mutation reachable only through such a parameter. Accepted callbacks are therefore
invoked exactly once per concrete candidate; the bridge does not probe them with extra calls.

## R2 import-resolution shadow API

`resolveProjectImports` parses imports with oxc and resolves them in Rust, but is
shadow-only: Sheriff still uses TypeScript by default. The API reports UTF-8 byte
offsets and the ordered `module | external | unresolvable` edge stream.

Before Rust resolution can be selected, every config in the hand-walked
`extends` chain is checked against the conservative allowlist in
`crate/src/resolve.rs`. Parent configs must be checked because
`ts.parseJsonConfigFileContent` inherits their options; inspecting only the
entry config's raw text would be unsafe. Unknown options and
`moduleSuffixes`, `rootDirs`, `customConditions`,
`allowImportingTsExtensions` or project references force a whole-project
TypeScript fallback. Reached packages use TypeScript 5.9.3-compatible
`typesVersions` range selection and path mapping for TypeScript's ASCII range
grammar; non-ASCII syntax, a numeric component larger than `u64`, rooted
package/target paths, or a selected path table whose usable patterns do not map
to string arrays remains on the conservative whole-project fallback.
Unparseable range keys and path patterns containing multiple `*` characters are
skipped just as TypeScript skips them. Parser/resolver
errors and differential shadow mismatches do the same; fallback is never
per-file. See `tools/engine-shadow/README.md` for the fixture harness and its
coverage limits.

The range parser is implemented locally instead of using Rust's cached `semver`
crate because `VersionReq` has a different grammar and semantics from
TypeScript's `VersionRange` (notably whitespace conjunctions, hyphen ranges,
wildcard partials, and prerelease-inclusive matching). No dependency was added.

## R4 incremental project handle

`ProjectHandle` starts at one absolute `entryFile`, resolves its transitive
graph, and retains interned paths, forward and reverse edges, module assignment,
tags, callback decisions, and overlays in Rust. Staleness is decided by the
change events the caller supplies (and, in the daemon, by its own TypeScript
dependency stamps) — the handle does not stamp the filesystem itself.
`applyChanges` accepts a versioned batch of created, modified, deleted,
renamed, directory, and overlay events. A content-only edit patches that file's
edges and reverse-edge entries; create/delete/rename, tsconfig, package manifest,
and directory events deliberately rebuild the reached graph.

Overlays are stored separately and never populate or replace disk state. Source
overlays are passed to extraction for only the overlaid file. Tsconfig-chain and
package-manifest overlays are read through the resolver's virtual filesystem and
force a graph rebuild; `clearOverlay` returns to the on-disk bytes. Executable
Sheriff configuration remains Node-owned, so setting or clearing an overlay for
a `sheriffConfigPaths` entry returns a structured error requiring a new handle
with the freshly evaluated config.

Module discovery also remains Node-owned. An `applyChanges` batch containing a
`created`, `deleted`, `renamed`, or `directory` event must include freshly
discovered `modulePaths`; the handle returns an error instead of analyzing with
possibly stale module membership or barrel status when they are omitted.

Function-valued configuration uses the same purity gate and candidate protocol
as `analyzeProject`. Candidate decisions are cached by their complete
materialized context and matcher id across native method calls; only the
batch-local candidate index is excluded from the key. The public JavaScript class
settles tag and rule candidates synchronously and returns serialized
`EngineOutput` from `applyChanges`, `setOverlay`, `clearOverlay`, and
`getResult`. `getReachedFiles` returns the sorted root-relative transitive file
set for differential testing.

For ordinary source modifications and source overlays, analysis reuses cached
module assignments, module tags, and per-file violation buckets. It rechecks the
changed file, its direct reverse importers, newly reached files, and direct
targets needed to evaluate those edges. Resolution-wide changes (tsconfig or
package manifests), structural events, and refreshed module discovery rebuild
the graph and conservatively reanalyze every reached file.
