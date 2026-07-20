# Rust engine R2 shadow harness

Run from the repository root after building the native artefact:

```bash
node packages/sheriff-engine/scripts/build-native.mjs
node tools/engine-shadow/run.mjs
```

The harness resolves every application source file in all eight `test-projects`
fixtures through both Sheriff's TypeScript implementation and the shadow-only
Rust API. The TypeScript side calls a narrow test seam around Sheriff's real
`resolveImports` function. The harness writes `report.json` and `summary.txt`,
and exits non-zero for any divergence or skipped fixture. Differences are classified as kind mismatch,
path mismatch, missing edge, or extra edge; occurrence order and duplicates are
part of the comparison.

Only `nextjs-i` and `angular-v-multi` contain fixture-local `node_modules` and
therefore exercise installed packages and real `exports` maps. The other six
fixtures exercise dependency-universe classification for their unresolved bare
imports; they must not be counted as equivalent installed-package coverage.

## Whole-project fallback whitelist

The Rust API walks the entire hand-resolved `extends` chain before resolution,
including parent configs. `ts.parseJsonConfigFileContent` does inherit parent
options, so checking only the entry config's raw text would be unsafe. Every compiler option must be in the
documented allowlist in `crate/src/resolve.rs`. The list contains the
resolution options covered by the fixture differential suite plus options that
do not affect `importedFiles` module resolution (emit, checking, decorator,
JSX, and editor/plugin settings).

The allowed names are `allowJs`, `allowSyntheticDefaultImports`, `baseUrl`,
`checkJs`, `declaration`, `declarationMap`, `downlevelIteration`,
`esModuleInterop`, `experimentalDecorators`,
`forceConsistentCasingInFileNames`, `importHelpers`, `incremental`,
`isolatedModules`, `jsx`, `lib`, `maxNodeModuleJsDepth`, `module`,
`moduleResolution`, `noEmit`, `noFallthroughCasesInSwitch`, `noImplicitAny`,
`noImplicitOverride`, `noImplicitReturns`,
`noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`,
`outDir`, `paths`, `plugins`, `resolveJsonModule`, `skipLibCheck`, `sourceMap`,
`strict`, `target`, `typeRoots`, `types`, and `useDefineForClassFields`.
`moduleResolution` is limited to `node`, `node10`, or `bundler`; `module` is
limited to `commonjs`, `es2022`, or `esnext`.

`moduleSuffixes`, `rootDirs`, `customConditions`,
`allowImportingTsExtensions`, project `references`, and dependency package
`typesVersions` always force TypeScript fallback. Unknown options do as well.
Any shadow divergence forces fallback for the whole project, never one file.
`shadowMode` only makes Rust produce comparison data after eligibility has
failed; it does not make the project Rust-eligible. The production/default
path remains TypeScript.
