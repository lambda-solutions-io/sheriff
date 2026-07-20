# Sheriff Rust engine — implementation plan & handoff

Working document for the `feat/rust-engine` branch. Written so any phase can be
picked up with **zero prior context**: read "Orientation", then the phase you are
starting.

---

## Orientation

### Why

Verify is slow on large projects. Measured on node 22 / darwin-arm64, synthetic
projects:

| Scenario | main before this work | after TS optimisations | Rust target |
| --- | --- | --- | --- |
| `verify`, 10.5k files | 8.4s | 2.2s | 0.8–1.4s |
| ESLint + 2 rules, 10.5k files | 181s | (see R-TS below) | 2–8s engine share |
| LSP document update | 2 full inits | 1 shared analysis | 1–10ms |
| Watch, 1-file change | full re-verify | full re-verify | 10–50ms |

The measured Rust `analyzeProject` call for a 10.5k-file / 38k-import project is
**41ms** (plus 6ms `JSON.stringify`, 0.4ms `JSON.parse`), versus ~2.2s for the
optimised TS path. The JSON boundary is *not* a bottleneck; do not redesign it
without new measurements.

### Architecture (decided, do not relitigate)

**Option B: a napi-rs engine crate, not a standalone binary and not a sidecar.**

- **Rust owns**: filesystem traversal, import extraction, module resolution,
  path interning, the project graph, module assignment, tag calculation, and the
  static rule checks.
- **Node keeps**: `sheriff.config.ts` evaluation (it is executable TS that can
  close over Node modules), function-valued rules, plugins, output formatting,
  and the daemon transport.
- Rejected: a full Rust binary (cannot honour the executable-config/plugin
  contract without embedding a JS runtime), and a Rust sidecar (the existing RPC
  protocol strips functions and ESLint would still need synckit). A sidecar can
  later wrap the same crate if a non-Node consumer appears.

### Ground rules

1. **The TS engine stays the default** until R5 flips consumers over. Every
   phase must leave `main`'s behaviour reachable and green.
2. **CI has no Rust toolchain.** `yarn link:sheriff` runs
   `nx run-many --target=build`. The Rust package must never enter that target
   set — no `project.json`, no `build` script (use `build:native`). Verify with
   `npx nx show projects --with-target build` → must list only `core`,
   `eslint-plugin`, `mcp-server`.
3. **The oracle is the contract.** `packages/core/src/tools/engine-oracle.ts`
   plus its snapshots define correct behaviour. The oracle is
   "sheriff under TS 4.8–5.7", *not* `tsc` and *not* oxc defaults.
4. **Zero-dependency policy is waived** (owner decision). Prefer real crates and
   npm packages over hand-rolled code — R1 shipped a hand-rolled regex engine
   under the old rule and it was wrong in 7 of 23 differential cases.
5. **Everything lands on one branch**, `feat/rust-engine`, as a single PR.

### Repository layout

```
packages/core/                     TS engine (unchanged default path)
  src/tools/engine-oracle.ts       contract dump: modules + violations, sorted, relative paths
  src/tools/tests/__snapshots__/   10 frozen scenarios
  src/lib/eslint/lint-document.ts  unified per-document analysis (R-TS)
packages/sheriff-engine/           npm pkg @lambda-solutions/sheriff-engine (private)
  index.js                         platform loader + static-config guard
  crate/src/                       lib.rs (napi), engine.rs, tags.rs, rules.rs,
                                   paths.rs, input.rs
  scripts/build-native.mjs         cargo build + copy artefact
  tests/conformance.spec.mjs       oracle conformance (gated)
Cargo.toml                         workspace root
vitest.engine.config.ts            engine-only vitest config
tools/perf/                        gen-bench.mjs, run-bench.mjs, baseline.json
```

### Commands

```bash
# tests (root vitest, NOT nx — there is no nx test target)
./node_modules/.bin/vitest run packages/core packages/eslint-plugin

# engine conformance (needs a built native artefact)
node packages/sheriff-engine/scripts/build-native.mjs
SHERIFF_ENGINE_NATIVE=1 ./node_modules/.bin/vitest run -c vitest.engine.config.ts

# rust
CARGO_NET_OFFLINE=true cargo test --offline
cargo clippy --offline --all-targets -- -D warnings && cargo fmt --check

# benchmarks
node tools/perf/gen-bench.mjs <dir> <domains> <filesPerModule>
node tools/perf/run-bench.mjs
```

### Environment quirks (they will bite you)

- **Codex agents run without network and with a read-only `.git`.** Pre-fetch
  cargo crates from the coordinator side and run cargo with
  `CARGO_NET_OFFLINE=true`. The coordinator commits on the agent's behalf.
  Cached crates: napi 2.16, napi-derive/napi-build 2, oxc_parser/oxc_ast/
  oxc_span/oxc_allocator 0.140, oxc_resolver 11.24.2, regex 1, fancy-regex 0.18,
  serde 1, serde_json 1, rustc-hash 2, rayon 1, memchr 2, dashmap 6.
- **`daemon-integration.spec.ts` fails with `listen EPERM` inside the sandbox.**
  That is environmental. Re-run outside the sandbox before believing a failure.
- **`yarn` is not on PATH** and corepack hijacks it to yarn 4, which rejects the
  yarn-1 lockfile. Use `npx` binaries directly.
- Worktrees do not share `node_modules`; symlink the main repo's.
- Do not put worktrees under `.codex-worktrees/` inside the repo — duplicate
  projects break the nx graph.

### Workflow per phase

1. Coordinator writes a detailed prompt; a codex agent implements it in the
   worktree (no commits).
2. Coordinator verifies **outside** the sandbox and commits.
3. **Two independent codex reviewers** run with different lenses (and different
   models, for diversity): one adversarial semantic-parity pass, one
   integration/build/perf pass.
4. Coordinator consolidates findings into one fix round, dispatches it, verifies,
   commits. Findings must come with a concrete failing input, not an opinion.

---

## Status

| Phase | State | Commits |
| --- | --- | --- |
| R-TS: verify-perf + `lintDocument` | done | `27762e6` (on main), `e3e2f8e` |
| R0: contract freeze | done | `4cd0b24`, `b55d719` |
| R1: crate + napi boundary | **done** | `60cf45c`, `eafb213`, `90eaf8e` |
| R2: oxc extraction + resolution | **done** | `df7319d`, `8ff89c9`, `bd266d3`, `694dc52` |
| R3: function-rule materialisation | **next** | |
| R4: incremental ProjectHandle | not started | |
| R5: consumer cutover + packaging | not started | |

---

## R-TS (done) — TypeScript track

Merged `codex/verify-perf` into main: segment-aware `findClosestModulePath`
(parent-dir walk against a `Set`, replacing an O(files×modules) `startsWith`
filter+sort), cheap fs probes, memoised wildcard regexes, lazy log thunks.
10.5k verify 8.4s → 2.2s. Also brought `tools/perf` and a perf regression suite.

Added `lintDocument(filename, content?)`: one cached analysis per document
instead of one per `(file, rule)`. `violatesDependencyRule` and
`violatesEncapsulationRule` are now thin adapters over it, `deep-import` routes
through the daemon bridge, and results are defensive serializable DTOs — which is
also the shape the napi boundary wants in R5.

Review-driven fixes worth remembering: dependency stamps (config + tsconfig chain
+ entry file) close a stale-analysis window; a 16-entry LRU caps retention at
~208 KiB instead of ~133 MiB across a 10.5k-file run; disk reads re-hash.

---

## R0 (done) — contract freeze

**`toFilePath` bugfix.** Dependency-rule matcher functions received the imported
*module* path where `DependencyCheckContext` documents the imported *file*.
Fixed; documented in `docs/docs/dependency-rules.md` as a behaviour change,
because a config doing `context.toFilePath.endsWith('/data')` can now see
`.../data/index.ts` and change verdicts.

**Duplicate import edges.** `UnassignedFileInfo` keyed raw specifiers by resolved
path, so `import './target'` plus `import './target/index.ts'` collapsed into one
edge with the wrong raw string. Now ordered `{importedFile, rawImport}` edges.

**The oracle** (`packages/core/src/tools/engine-oracle.ts`) emits sorted,
root-relative, forward-slashed JSON: `files[]` with `imports[]`
(`raw`, `resolvedPath`, `kind`), `modules[]` (`path`, `tags`, `isBarrel`), and
`violations` split into `dependency` / `encapsulation` / `external`. Ten frozen
scenarios cover barrels, barrel-less encapsulation, placeholder tags, deny rules,
segment boundaries (`src/a/b` vs `src/a/bc`), `toFilePath`-sensitive function
rules, declared-but-uninstalled externals, `noTag` fallback, and
`ignoreFileExtensions`.

`src/tools/**` is excluded from the published lib build and not exported from
`index.ts`.

---

## R1 (done) — engine crate + napi boundary

**Goal**: Rust reproduces module assignment, tags, and all three violation kinds
from *pre-resolved* edges supplied by TS. Resolution itself stays in TS until R2,
so this phase carries no resolver risk.

**Shipped**: cargo workspace; `packages/sheriff-engine` with a cdylib crate
exposing `analyzeProject(inputJson) -> outputJson`; `u32` path interning;
segment-aware module assignment; static tags; dependency/deny/external/
encapsulation checks; deterministic rayon fan-out (indexed collect, sort after);
panic-safe FFI via `catch_unwind`; 18 Rust tests; a gated JS conformance suite.

**EngineInput** carries `rootDir`, `files[]` with classified imports,
`modulePaths[]` (discovery stays in Node for now), the static module config,
`autoTagging`, `depRules`, `denyRules`, `externalRules`, `encapsulationPattern`.
Function-valued config is refused by the JS wrapper *before* reaching Rust with
`EngineUnsupportedConfigError`. **EngineOutput** matches the oracle schema
exactly.

**Fix round in flight — 15 findings.** The important ones:

- *Regex parity (critical)*: a hand-rolled matcher diverged from JS `RegExp` in
  7 of 23 differential cases. Two were silent: `a|ab` against `"ab"` matched in
  Rust but not in JS (JS takes the leftmost alternative, so `match[0]` is `"a"`,
  failing TS's `match[0] === input` rule), and in-pattern anchors like `^abc$`
  failed in Rust. Backreferences silently returned false; lazy quantifiers and
  lookarounds threw. Fix: `fancy-regex`, run **unanchored** and compare
  `match[0]` to the whole input — compiling `^(?:pattern)$` would wrongly match
  `a|ab`. Probe: `scratchpad/regex-probe.mjs`.
  Note `rules.rs::wildcard_matches` is correct as hand-rolled code and must stay:
  `wildcardToRegex` escapes every metacharacter except `*`.
- *Placeholder insertion order*: TS replaces in insertion order, so
  `<domain>/<type>` against `<type>/foo` yields `result:foo`; a hash map cannot
  reproduce that.
- *Replacement-string semantics*: TS passes captures to `String.replace`, so
  `$&`, `` $` ``, `$'`, `$n`, `$$` are special.
- *Mixed separators*: TS assigns `/repo/src/a\b/source.ts` to the root module
  (a real violation); normalising separators hides it.
- *Root-prefix fallback*: TS assigns out-of-root files to root; Rust errored.
- *`null` matchers* are valid TS config meaning "deny"; `enableBarrelLess`
  defaults to `false`.
- *Hostile input*: no caps on size or nesting; recursive parsers can abort the
  process in a way `catch_unwind` cannot rescue.
- *Test gap*: conformance covered 4 of 10 snapshots and the `.spec.mjs` file was
  invisible to the normal vitest command. It had also special-cased `sameTag` to
  fake a pass — removed in favour of an explicit "requires R3" skip.

**Scope call**: reviewer A rated missing function-rule support a BLOCKER. It is
**R3 scope, by design** — R1 is static-only and the wrapper refuses functions.
R1's obligation is only that the refusal is airtight and the gap is visible.

**Exit criteria — all met** (`eafb213`, `90eaf8e`):

- Regex probe: 7 divergences → 0 real ones (the single remaining row is a
  harness limitation — an empty module directory cannot be expressed as a path).
- Path semantics verified by probe: out-of-root files fall back to root;
  `/repo/src/a\b/source.ts` is assigned to root and reports the cross-module
  violation, matching TS byte-for-byte.
- Conformance: 8 of 10 oracle scenarios pass natively; 2 skip with an explicit
  "requires R3" reason (they use function-valued rules). Fixtures are now shared
  with the oracle spec via `oracle-fixtures.ts`, so both sides test one
  definition. Zero snapshot churn.
- 25 Rust tests, `cargo clippy -D warnings` clean, `cargo fmt --check` clean.
- Full suite passes identically **with and without** the native artefact
  (587 passed / 13 skipped both ways) — CI needs no Rust toolchain.
- Input limits are enforced (`MAX_INPUT_JSON_BYTES` 64 MiB, `MAX_FILES` 100k,
  `MAX_IMPORTS` 1M, `MAX_REGEX_BYTES` 4 KiB, …) with structured errors.

**Process note**: the fix-round agent was killed by SIGTERM before writing its
report. Thirteen findings were complete; the coordinator verified each one
independently and dispatched the missing conformance work separately. Do not
trust an agent's silence as failure, or its report as proof — re-verify.

---

## R2 (done) — oxc extraction + resolution, shadow mode

**Goal**: Rust produces the import edges itself. **Highest-risk phase.**

**Shipped**: `extract.rs` (oxc parser, `preProcessFile`-equivalent), `resolve.rs`
(tsconfig walk, alias matching, classification, fallback whitelist),
`js_replacement.rs` (shared JS `String.replace` semantics), and
`tools/engine-shadow/` — a dual-engine differential harness. TS remains the
default; Rust runs shadow-only.

**Result**: 434 files, 1357 edges per engine, **zero divergences**. Two of eight
fixtures now have real `node_modules` installed (`nextjs-i`, `angular-v-multi`),
which is what made `exports`-map and subpath resolution testable at all — the
other six exercise dependency-universe classification only.

**Contract corrections found while implementing** (the PLAN was wrong; the code
is authoritative):

- Plain `require()` and triple-slash references are **not** extracted — R2 step 1
  above asked for them, but `ts.preProcessFile` is called with one argument
  (`detectJavaScriptImports = false`) and `referencedFiles` is ignored.
  Capturing them would *create* divergence.
- No-substitution template dynamic imports (`` import(`./x`) ``) **are**
  captured by TS; substituted ones are not.
- `ts.parseJsonConfigFileContent` **does** inherit options through `extends`,
  even with an inline read callback. An entry-config-only whitelist audit would
  silently miss unsupported parent options, so the audit walks the whole chain.

**Review round — 6 confirmed divergences, all silent (`fallback: false`)**, found
by two independent reviewers and reproduced against both engines before and
after the fix (`bd266d3`). The shadow harness passed while every one was live,
so each is now a permanent regression test:

- `.json` imports fabricated a `module` edge where TS emits none.
- Package `exports` conditions: TS `external` vs Rust `unresolvable`.
- The `typesVersions` audit only inspected the dependency universe, which
  excludes devDependencies — so a devDependency's `typesVersions` affected
  resolution while escaping the audit.
- Alias replacement used a literal `replacen`; TS routes through
  `String.replace`, so `$&`, `` $` ``, `$'`, `$n`, `$$` are special. R1 had
  already solved this for tag placeholders; it is now shared code, not a second
  implementation.
- A dynamic import with a surrogate-pair escape was dropped entirely (`\uXXXX`
  decoded per-unit into a Rust `char`; lone surrogates are invalid).
- Scoped-package extraction yielded `@scope/` vs TS's `@scope`.

**Hardening**: R2 reads sources from disk, so the input-JSON cap bounded nothing
— a 3.9 MB / 200k-import file resolved without error. Per-file size, import
count, and *acyclic* tsconfig depth are now capped.

**Cyclic `extends`** hung *both* engines identically (neither walker had a
visited set). Fixed in both together as `SH-019` (`694dc52`) — patching only
Rust would have created a divergence. Detection is an exact visited-set, not a
depth heuristic, so deep-but-valid chains are unaffected.

**Known limitations carried into R4/R5** — do not mistake these for done:

1. **The `typesVersions` fallback is too conservative to ship.** `@types/node`
   declares `typesVersions`, so effectively *any* project with real
   `node_modules` falls back to TS wholesale — both installed fixtures now do.
   Correct, but it means the R5 cutover would deliver no speedup. R5 must either
   implement `typesVersions` resolution or detect whether it actually affects
   the specifiers in play.
2. **Graph-discovery parity is untested.** The harness enumerates files from
   disk; production starts at an entry file and follows resolved imports.
   Per-file coverage is a *superset* (production reached 10 files where the
   harness compared 30), so it cannot inflate the zero-divergence claim — but
   *which files get reached* is not compared. R4/R5 must cover it.

---

## R2 (original plan, for reference)

`oxc_resolver` is a port of enhanced-resolve / tsconfig-paths / tsconfck, *not*
of `ts.resolveModuleName`. Expect divergence around `exports`/`imports`
conditions, `typesVersions`, `.mts`/`.cts`, `moduleSuffixes`, `rootDirs`, and
version-specific behaviour. Sheriff also layers its own semantics: a manual
`extends` walk where the furthest config directory becomes `rootDir`, only the
**first** target of each `paths` entry is materialised, and alias resolution
takes **priority over** the normal TS result.

**Steps**

1. `crate/src/extract.rs` — oxc parser import extraction matching
   `ts.preProcessFile`'s `importedFiles`: static imports, `export … from`,
   dynamic `import()`, `require()`, type-only imports, triple-slash references.
   Set `SourceType` per extension. Record byte offsets for later LSP use.
2. `crate/src/resolve.rs` — `oxc_resolver` driven from the tsconfig chain, with
   sheriff's priority order: tsconfig-paths alias first (wildcard + exact, first
   target only), then normal resolution, then classification into
   module / external / unresolvable (the last consults the nearest
   `package.json` dependency universe).
3. **`tools/engine-shadow/`** — the deliverable that matters. Dump
   `{file, raw, kind, resolvedPath}` per import from *both* engines and diff
   them, classifying divergences (kind mismatch, path mismatch, missing/extra
   edge) with examples. Run across every `test-projects/*` fixture and report
   coverage honestly, including which projects were skipped and why (several
   have no installed `node_modules`, and agents have no network).
4. **Fallback policy** — a conservative whitelist of compiler options we know we
   replicate, checked *before* Rust resolution is used. Anything outside it, or
   any divergence detected in shadow mode, falls back to TS **for the whole
   project**.
5. Rust unit tests per import syntax form, per alias-matching shape, and per
   classification branch.

**Exit criteria**: zero divergences across all runnable fixtures; whitelist
documented; TS remains the default path.

**Reviewer lenses**: (A) resolution semantics vs `ts.resolveModuleName`,
especially alias priority, extension substitution, and external classification;
(B) shadow-harness honesty — does it actually cover what it claims, and does the
fallback truly trigger?

---

## R3 — function-rule materialisation

**Goal**: support function-valued `depRules` / `denyRules` / `externalRules` and
tag functions without per-edge JS calls.

The naive "enumerate all `(fromTag, toTag)` pairs" table is **unsound**:
`RuleMatcherFn` receives `{from, to, fromModulePath, toModulePath, fromFilePath,
toFilePath, fromTags, toTags}`, so verdicts can differ per file. The domain is
finite only over the *realised graph*.

**Protocol**

1. Node evaluates the config; static rules compile in Rust as today.
2. Rust builds the graph and modules; Node materialises `moduleId → tags`
   (tag functions see placeholders and `matcherContext`).
3. Rust emits callback candidates for the **real** cross-module edges and
   external imports only.
4. Node evaluates them in **one batch**; Rust receives a decision table keyed by
   matcher id plus the full concrete context.
5. Ordering, allow/deny precedence, and violation construction stay in Rust.

Do **not** call back into JS per edge (it serialises onto the JS thread and
defeats parallelism) and do **not** embed QuickJS (config closes over Node).

**Contract change**: batching changes the observable invocation count and order
for stateful callbacks. Document callbacks as deterministic and side-effect-free,
and keep a slower compatibility path for configs that opt out.

**Exit criteria**: the fn-rule oracle snapshots skipped in R1 now pass; a config
with a deliberately impure callback is either rejected or routed to the
compatibility path.

---

## R4 — incremental ProjectHandle

**Goal**: a persistent handle so watch/LSP work is proportional to the change.
Today watch invalidates and re-verifies everything; cached parsing is not
incremental verification.

- A `ProjectHandle` holding the interned graph, modules, tags, and resolutions.
- Content overlays for unsaved editor buffers (must never poison on-disk caches
  — see the `entryFileContent` note in `traverse-filesystem.ts`).
- Apply fs events: re-resolve changed imports, update reverse edges,
  rematerialise only affected callback contexts, recheck affected files.
- Track dependencies on source files, the whole tsconfig chain, `package.json`,
  directory structure, symlinks, and config files. **Over-invalidate first**;
  tighten with evidence.
- Equivalence test: graph hash after N incremental updates must equal a clean
  rebuild. Fuzz with random edit sequences.
- **Graph-discovery parity (untested since R2).** The R2 shadow harness compares
  per-file resolution only: it enumerates files from disk, while production
  starts at an entry file and follows resolved imports. Extend the differential
  to compare the *reached file set* from a given entry, not just the edges of
  files handed to it.

**Exit criteria**: 10–50ms typical single-file update; incremental and clean
rebuilds provably identical; entry-driven reached-file sets identical between
engines.

---

## R5 — consumer cutover + packaging

- CLI `verify` and the ESLint rules call the engine directly, behind an opt-in
  flag first (`SHERIFF_ENGINE=1`), with automatic fallback to TS when the native
  artefact is missing or the config is unsupported.
- The daemon hosts a `ProjectHandle` and keeps its existing RPC surface, so
  mcp-server and the LSP branch need no changes.
- Packaging with `@napi-rs/cli` (npm deps are allowed now): per-platform
  `optionalDependencies`, napi-standard triples (`darwin-arm64`, `linux-x64-gnu`,
  `linux-x64-musl`, `win32-x64-msvc`, …), checksums, and an install test on a
  machine without a Rust toolchain. Set `private: false` and add an `exports`
  map when publishing starts.
- Freeze result shapes, traversal order, and message text **before** flipping the
  default; the daemon's lint DTO is already lossier than the in-process one.
- **Narrow the `typesVersions` fallback (blocker for any speedup).** R2 made the
  audit conservative to close a silent divergence: any installed package
  declaring `typesVersions` falls the whole project back to TS. `@types/node`
  declares it, so in practice every real project falls back and the engine never
  runs. Either implement `typesVersions` resolution, or determine whether it
  affects the specifiers actually in play. Benchmarks are meaningless until this
  is fixed — measure the fallback rate on real projects first.

**Exit criteria**: benchmarks for cold verify / ESLint / watch on 2.1k and 10.5k
projects; all `test-projects` goldens byte-identical; documented rollback;
**fallback rate on real projects measured and acceptable** (see above).

---

## Open questions for the owner

1. When may the engine become the **default** (rather than opt-in) — after R5
   benchmarks, or only after a release cycle of opt-in soak?
2. Is the "callbacks must be pure" contract change acceptable in a minor
   release, or does it need a major?
3. Which platforms must ship prebuilds at launch (musl? win32-arm64?).
