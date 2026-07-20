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
