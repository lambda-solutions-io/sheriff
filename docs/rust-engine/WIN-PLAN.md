# How Rust wins — measured diagnosis and plan (2026-07-21)

Status: diagnosis complete, all numbers measured this session on the 10.5k synthetic
project (10,511 files reached, 38,010 imports, 1.94 MB of source). Machine: darwin
arm64, 10 cores (8 performance + 2 efficiency), Node 22.

---

## 1. Two load-bearing beliefs were wrong

The R5.3/R5.4 conclusion — "the engine's win is the warm path only; cold verify
cannot win because per-invocation marshalling eats it" — rests on two claims that
do not survive measurement.

**Belief 1: "marshalling the 10k-file JSON result is the cost."** Refuted.

| boundary cost, 10,511 files | measured |
|---|---|
| `getResult()` Rust-side serialize | **1.1 ms** |
| Node `JSON.parse` of the result | **11.2 ms** |
| payload | 3.89 MB |

~12 ms combined = **under 1% of the ~1697 ms engine verify**. Every proposal aimed
at the boundary (structured napi values instead of JSON strings, returning only
formatted violation text, avoiding bulk marshalling) is worth ~12 ms at most.

**Belief 2: "warm Rust work is only ~160 ms."** Artifact. That figure is prose in
`PLAN.md:872` and is produced by **no timer in the codebase** — there is zero
timing instrumentation in the crate (no `Instant::now()` anywhere). Measured
directly against the native binding, `new ProjectHandle(...)` — full discovery +
resolve + analysis — takes **930–1005 ms** (median ~960 ms, 5 stable runs), i.e.
~91 µs/file, not ~15 µs/file.

**Therefore:** engine verify ≈ ~960 ms real Rust analysis + Node/CLI overhead +
~12 ms marshalling. Rust's own analysis is only ~1.7× faster than the *entire*
TypeScript path (~1650 ms). That is the actual problem, and it is a fixable one:
none of the ~960 ms is spent on anything Rust is inherently slow at.

## 2. Where the 960 ms goes

| phase | cost | character |
|---|---|---|
| `refresh_dependency_stamps` (`handle.rs:1246`) | **~313 ms** | watch bookkeeping, discarded by cold verify |
| file reads (10,511 files) | ~180 ms serial (78 ms with rayon) | syscall-latency bound, trivially parallel |
| oxc parse + resolve 38,010 imports | ~460 ms | serial; ~71% of resolutions are duplicates |

**The single biggest item is not analysis at all — and it is dead code.**
`refresh_dependency_stamps` is ~⅓ of construction, and the map it fills is
**never read anywhere in the crate**. Every reference to `dependency_stamps` is a
declaration or a write: declared `handle.rs:184`, initialized `:290`, inserted
`:484`, cleared `:1247`, filled `:1291`. There is no lookup, comparison, or
getter, and it is not exposed to JS. (Verified independently after codex gpt-5.5
flagged it. Note the daemon *does* use dependency stamps for its freshness
barrier — but its **own TypeScript ones**, `engine-lint-host.ts:169` / `:291` —
which is why removing the Rust map costs nothing.)

So this is not merely "watch bookkeeping the CLI discards": it is ~313 ms of pure
waste on **every** construction, cold and warm alike. It walks
every ancestor of every file calling `package_json.exists()`, then makes a **second**
ancestor pass calling `fs::symlink_metadata`, with **no memoization across files in
the same directory**; it then stamps 12,514 paths and `directory_hash`es all 2,003
directories (`read_dir` + sort each). Replicated 1:1 in a standalone Rust probe:
252 ms crawl + 60 ms stamping = 313 ms.

**Resolution is ~71% redundant.** The 38,010 imports contain only ~11,010 distinct
`(directory, specifier)` pairs, so ~27,000 resolver invocations repeat a request
already answered. `oxc_resolver` shares filesystem/package metadata caches, but
neither it nor Sheriff caches the *final resolution result* — `resolve.rs` contains
no caching at all (grepping its 3,249 lines for cache/Cache returns nothing).

**Nothing is parallel where it matters.** `rayon` appears in exactly one place,
`engine.rs:423` `files.par_iter()`, which parallelizes `check_file` — the *cheap*
rule-checking stage — in the stateless path. The expensive path, `rebuild_graph`
(`handle.rs:567`), is a serial BFS: `while let Some(path) = queue.pop_front()`
calling `session.resolve_file()` one file at a time (read → parse → resolve).
This is the path both `verify` and the daemon actually use. On a 10-core machine.

**Ruled out.** The TypeScript `findClosestModulePath` O(files×modules) hotspot was
*not* ported into Rust — `handle.rs:772-796` correctly walks parent directories
against an `FxHashSet`. Hash choice is fine (69 `Fx*` sites vs 13 std).

**Parallelization is safe.** Every engine output is explicitly sorted before
serialization (`engine.rs:439-441` violations, `:455` modules, `:484` files,
`:447`/`:949` tags), so results are order-independent by construction — which is
exactly why `check_file` can already use `par_iter`. Report ordering is
reconstructed Node-side from the import graph (the R5.4 DFS), not from analysis
order. The only blockers in `ResolveSession` (`resolve.rs:485`) are three mutable
accumulators — `import_count`, `reached_packages`, `context.fallback_reasons` —
all trivially per-worker-local then merged. The resolver itself is built once
(`resolve.rs:521`) and shared.

## 3. The warm path needs the opposite fix

| warm single-file `applyChanges` | measured |
|---|---|
| Rust | **64.2 ms** |
| Node `JSON.parse` | **10.7 ms** |
| payload **per keystroke** | **3.89 MB** (all 10,511 files + 38,010 imports) |

`reached_file_imports()` (`handle.rs:1136`) rebuilds the entire file/import
structure as boxed `serde_json::Value` trees (a `json!` per file *and* per import),
sorts all 10,511 paths, and re-serializes — on **every** change, however small.
`merged_analysis_output` (`handle.rs:1125`) calls it unconditionally. The genuine
incremental work for one file is microseconds; ~75 ms is rebuilding and
re-marshalling a structure that did not change.

So: **cold is CPU-bound in serial Rust; warm is bound by full-payload rebuild.**
The boundary is irrelevant to cold and dominant in warm. One plan cannot be a
single optimization.

## 4. Plan

Ordered by expected value per effort. Each phase carries the measurement that
validates or kills it. **Parity rule throughout: byte-identical output or fall
back** — the existing `verify-engine.spec.ts` `toEqual(typescript)` gate and the
reverse-lexical ordering fixtures from R5.4 stay green, and reached-file count is
asserted before any number is believed.

### P0 — instrument first (½ day)
There is no timer in the crate; every attribution above came from external probes.
Add `Instant::now()` phase timers behind `SHERIFF_ENGINE_PROFILE=1` around: config
parse, BFS discovery, per-file read, parse, resolve, `refresh_modules`,
`refresh_dependency_stamps`, analysis, serialize. **Without this, every later phase
is guesswork and the ~160 ms mistake repeats.** Validation: the emitted phases sum
to the wall clock measured externally (~960 ms).

### P1 — delete the dead dependency-stamp pass (~313 ms, lowest risk in the plan)
The map is never read (§2). Deleting `refresh_dependency_stamps` and its call
sites removes ~313 ms from **every** construction — cold *and* warm — with no
behavioural change, because the daemon's staleness check uses its own TypeScript
stamps (`engine-lint-host.ts:169`/`:291`).

Do this first: it is the largest single win, benefits both halves of the goal, and
carries essentially no parity risk. If a future incremental design wants Rust-side
stamps, reintroduce them lazily and memoized (10,511 files share ~2,003
directories; the two ancestor passes should be one). Kill criterion: if cold
verify does not drop by ≥250 ms, the attribution is wrong — stop and re-measure.

### P2 — parallelize discovery (~2–4×, medium risk)
Convert `rebuild_graph`'s serial BFS into wavefront-parallel rounds: each round
`par_iter`s the frontier (read + parse + resolve), collects newly discovered paths,
dedups, and forms the next frontier. Per-worker accumulators for `import_count`,
`reached_packages`, `fallback_reasons`, merged deterministically (sort
`fallback_reasons` — already done at `resolve.rs:519`). Measured ceiling for the
I/O component alone: 180 ms → 78 ms. Validation: byte-identical output on all
`test-projects` goldens plus the parity spec; wall clock on 10.5k.

### P3 — memoize resolution (~71% of ~460 ms, low risk)
Add a `(containing dir, specifier) → resolution` cache in `ResolveSession`
(`FxHashMap`, or `DashMap`/sharded once P2 lands). ~27,000 of 38,010 lookups are
repeats. Validation: instrument hit rate (expect ~70%); output unchanged.

### P4 — drop the TypeScript compiler from the fast path (~100 ms, low risk)
`resolveProjectConfig` (`main/resolve-project-config.ts:26`) calls `generateTsData`,
which loads the TS compiler purely to parse tsconfig — work Rust already does in
`ResolveSession`. `require('typescript')` costs ~120 ms of the ~140 ms Node floor
(bare Node is ~20 ms). Have the engine path take tsconfig data from Rust and load
TS only on fallback. Also delete the two dead full-payload round trips in
`verify.ts`: line 316 parses the entire multi-MB constructor result and **discards
it** (only to check for an `error` key), and `getReachedFiles()` at line 317 ships
a third copy of a path list already present in `output.files[]`.

**Cold-path arithmetic:** 1697 − 313 (P1) − ~250 (P2 on the parse/resolve+read
remainder) − ~200 (P3, overlapping P2) − ~100 (P4) lands in the **~600–850 ms**
band against TS's ~1650 ms — a clear 2–2.7× win, without a daemon, without
touching parity. That is the case for cold verify being winnable; P0's numbers
decide whether it holds.

### P4b — other dead/duplicated state (codex findings, ~1.1–1.25×, low risk)
Cheap cleanups worth folding into P1–P4 rather than a separate phase:
- `module_assignment` (`handle.rs:772`) and `file_paths` are maintained but never
  queried outside their own maintenance — same dead-state pattern as the stamps.
- `reached_files()` (`handle.rs:823`) re-runs a fresh BFS repeatedly *during*
  construction; cache it.
- Every resolved edge builds an absolute `PathBuf` and queues it even when already
  discovered (`handle.rs:696`); dedup before insertion, not after popping (`:590`).
- The handle materializes a second owned `EngineInput`, cloning every raw import
  and resolved path (`handle.rs:843`), then `engine::analyze` builds *another*
  interner/file map/module map (`engine.rs:228`, `:334`) and output construction
  clones the strings again (`engine.rs:457`). Analyzing the handle's interned
  graph directly removes two full copies — higher parity risk, do it last.
- Latent (small on this fixture, potentially large on real configs): every
  cross-module edge scans every ordered dep/deny rule per tag pair
  (`rules.rs:32`/`:69`); `wildcard_matches` allocates a `Vec<char>` and DP rows per
  call (`rules.rs:3`); module-config regexes are recompiled per attempted match
  (`tags.rs:187`, `js_regex.rs:61`); every import scans all tsconfig path mappings
  (`resolve.rs:1432`); bare imports re-walk ancestors for manifests and may reread
  `typesVersions` (`resolve.rs:2204`, `:1926`). The 10.5k fixture (one `'*'→'*'`
  rule, no callbacks, no regex config, no `paths`) hides these — **benchmark a
  realistic config before declaring victory.**

### P5 — warm path: stop shipping 3.89 MB per keystroke (~75 ms → single digits)
Return a **delta** from `applyChanges`: changed files, their imports, and violation
deltas, keeping the full-payload call available for initial sync. This is the one
place where the boundary genuinely matters. Editor latency is what users feel, and
it is the half of the goal that is already 23× ahead — this is what makes it feel
instant rather than merely fast. Validation: daemon integration test still asserts
a byte-identical DTO; measure p95 keystroke-to-diagnostic.

### P6 — re-benchmark and decide the default
Re-run `tools/perf/run-engine-bench.mjs` (it hard-fails on any fallback — keep that)
on 2.1k, 10.5k, and both real fixtures. Then revisit "when does the engine become
the default".

## 5. Kill criteria (honest)

Stop investing in the Rust **cold** path and scope the engine to warm/editor only if:

- After P0+P1, cold verify has not moved by ≥250 ms — the attribution above is
  wrong and the remaining cost is somewhere unmodelled.
- After P2, parallel discovery yields <1.5× on the discovery phase — implies a
  hidden serialization point (a lock, or oxc_resolver contention) that makes the
  multicore assumption false.
- Parity cannot be held: if P2/P3 force observable divergence that the fallback
  path cannot absorb, correctness wins and the cold path is not worth it.
- If after P1–P4 cold verify is still not decisively under TS, the honest
  recommendation is: **keep the engine for daemon/editor (where it is 23× and P5
  makes it ~10× better again), leave cold `verify` on TypeScript**, and stop
  paying complexity for a path that cannot win.

The warm path is **not** subject to these kill criteria — it is already measured as
a large win and P5 is a contained, high-confidence improvement.

## 6. Reproduction notes

- The raw binding (`packages/sheriff-engine/native/binding.js`) takes a **JSON
  string**, not an object — `index.js` does the stringify. Calling it with an
  object throws a confusing conversion error.
- Always assert reached-file count (10,511) before trusting any number; a prior
  session produced meaningless ~400 ms numbers after silently breaking reachability
  to 12 files.
- The bench harness must hard-fail on fallback lines; a compiled CLI that cannot
  resolve the engine falls back 100% and "measures Rust" while running TypeScript.
- Code reading cannot separate parser CPU from resolver CPU from filesystem time.
  For P0, profile the real `.node` with symbols:
  `CARGO_PROFILE_RELEASE_DEBUG=2 node packages/sheriff-engine/scripts/build-native.mjs`
  then `samply record -- node tools/perf/run-handle-bench.mjs` (or `xcrun xctrace
  record --template 'Time Profiler' --launch -- "$(command -v node)" …` on macOS).
  Look for `refresh_dependency_stamps`, `directory_hash`,
  `ResolveSession::resolve_file`, `oxc_parser::Parser::parse`,
  `ResolverImpl::resolve_file`, `PathInterner::intern_relative`, allocator frames.

## 7. Provenance

Every number here was measured this session against the real native binding, not
inferred. Independent confirmation across three tracks: my own probes, codex
gpt-5.5 (hotspot audit — contributed the dead-`dependency_stamps` finding and the
27k-redundant-resolutions count), and a Claude boundary audit (contributed the
`verify.ts:316` discarded-parse and the duplicated `findModulePaths` fs walk).
The dead-stamps claim was verified by hand before being written into the plan.
