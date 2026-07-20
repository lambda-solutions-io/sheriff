# Sheriff Rust engine

The native engine accepts the versioned JSON shape declared in `index.d.ts`. Invalid regular
expressions and resource-limit violations are returned as structured engine errors; the N-API
boundary never intentionally panics for user configuration. Tag matcher regular expressions use
JavaScript's first, leftmost match and only match when that first match is the complete segment.

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
callback is invoked.

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
