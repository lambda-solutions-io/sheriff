---
sidebar_position: 4
title: Configuration Reference
displayed_sidebar: tutorialSidebar
---

This page provides a comprehensive reference for all configuration options available in Sheriff. The configuration is defined in a `sheriff.config.ts` file located in your project's root directory.

> **💡 Quick Start**: Use `npx sheriff init` to automatically generate a `sheriff.config.ts` file with sensible defaults. See the [CLI documentation](./cli.md) for more details.

## Configuration Structure

```typescript
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  // Your configuration options here
};
```

Alternatively, use `defineConfig` to get the same autocompletion and type
checking without the type annotation:

```typescript
import { defineConfig } from '@lambda-solutions/sheriff-core';

export const config = defineConfig({
  // Your configuration options here
});
```

`defineConfig` returns its argument unchanged, so both styles are equivalent.
The export must still be named `config`.

## Mandatory Options

These options are required for Sheriff to function properly. You need to understand and configure these for Sheriff to work effectively.

### `modules` {#modules}

- **Type**: `ModuleConfig`
- **Description**: Defines the modules and assigns tags. This is the primary way to structure your project. If you don't define modules, you must enable `autoTagging` for Sheriff to work. See [Module Boundaries](./module_boundaries.md) for detailed examples.

Module values can be a tag string, a tag array, a tag matcher function, or an explicit module definition with `tags` and optional file-level `exports`.

```typescript
export const config: SheriffConfig = {
  modules: {
    'domains/booking/api': {
      tags: ['type:api', 'port'],
      exports: ['*.port.ts'],
    },
  },
};
```

`exports` is only needed when a barrel-less module should expose a smaller public API than "everything except `internal`". The patterns are matched against paths relative to the module folder. A `*` matches within one path segment only, so `*.port.ts` matches `booking.port.ts` but not `internal/admin.port.ts`; use `internal/*.port.ts` when a subfolder is intentional. If `exports` is omitted, existing barrel-less behavior is unchanged; if it is an empty array, no files are public outside the module.

Because `tags` is also a valid folder name, an object with only `tags` or with `tags` and `exports` is interpreted as an explicit module definition. If a leaf folder is literally named `tags`, express it with a path key or include it in a nested config that also has another child:

```typescript
export const config: SheriffConfig = {
  modules: {
    'src/app/tags': ['type:tags-folder'],
  },
};
```

### `exports` {#exports}

- **Type**: `string[]`
- **Default**: `undefined`
- **Description**: Defines the public files of one barrel-less module when that module uses the object form in `modules`.

```typescript
export const config: SheriffConfig = {
  modules: {
    'domains/booking/api': {
      tags: ['type:api', 'port'],
      exports: ['*.port.ts', 'public-*.ts'],
    },
  },
};
```

`exports` patterns are matched against paths relative to the module folder. A
wildcard is segment-local: `*.port.ts` exports `booking.port.ts`, while
`sub/*.ts` exports `sub/public.ts` but not `sub/deep/public.ts`.

Without `exports`, barrel-less modules keep the default behavior: every file is
public except files below the configured encapsulation folder. With `exports`,
the list is the public API and takes precedence over that default convention,
so `exports: ['internal/public.ts']` intentionally exposes that file. With
`exports: []`, no files are public outside the module.

### `depRules` {#deprules}

- **Type**: `DependencyRulesConfig`
- **Description**: Defines dependency rules between modules. Even with defaults, you should understand how this affects your project structure. See [Dependency Rules](./dependency-rules.md) for detailed examples.

### `denyRules` {#denyrules}

- **Type**: `DependencyRulesConfig`
- **Default**: `{}`
- **Description**: Defines dependency rules that forbid imports even when `depRules` would otherwise allow them. Sheriff evaluates `denyRules` after `depRules`; a matching deny rule wins over clearance from `depRules`.

```typescript
export const config: SheriffConfig = {
  modules: {
    'src/domain': ['domain:booking', 'type:domain'],
    'src/shared': ['shared'],
  },
  depRules: {
    '*': 'shared',
    'type:domain': 'type:domain',
  },
  denyRules: {
    'type:domain': ({ to }) => to !== 'type:domain',
  },
};
```

`denyRules` never grant access. If no deny rule matches, the `depRules` result stands. A tag without a `denyRules` entry is normal and does not raise a missing-rule error.

### `externalRules` {#externalrules}

- **Type**: `Record<string, string[] | ExternalRuleMatcherFn>`
- **Default**: `{}`
- **Description**: Restricts imports from external libraries in `node_modules` according to the importing module's tags.

```typescript
export const config: SheriffConfig = {
  modules: {
    'src/domain': ['type:domain'],
    'src/api': ['type:api'],
    'src/infra': ['type:infra'],
  },
  depRules: {
    '*': '*',
  },
  externalRules: {
    'type:domain': [],
    'type:api': ['@angular/core'],
    'type:infra': ['@angular/*', 'rxjs'],
  },
};
```

Rule keys support wildcards and are matched against source tags. Library
patterns are matched against the full import string, so `@angular/core` does
not match `@angular/core/testing`; use `@angular/*` to allow both. When an
importing module has multiple tags with matching rules, every rule must allow
the import. One veto is enough to report a violation.

An empty array forbids every external import for the matching tag. A tag with
no matching key is unrestricted, which keeps configurations without
`externalRules` unchanged.

Uninstalled packages are also governed by `externalRules` when the nearest
`package.json` declares them in `dependencies`, `peerDependencies`, or
`optionalDependencies`. Undeclared imports that cannot be resolved remain
unresolvable and are not treated as external libraries.

## Optional Options

These options have sensible defaults and are typically only customized for specific use cases.

### Recommended Options

#### `entryFile` {#entryfile}

- **Type**: `string`
- **Default**: `''`
- **Description**: Single entry file path for Sheriff to start traversing imports. Cannot be used together with `entryPoints`.

#### `entryPoints` {#entrypoints}

- **Type**: `Record<string, string>`
- **Default**: `undefined`
- **Description**: Multiple named entry points for workspaces with multiple applications. Cannot be used together with `entryFile`.

**Recommendations:**

- **Use `entryFile`** for single applications or simple projects
- **Use `entryPoints`** for monorepos, workspaces, or projects with multiple applications
- **Example monorepo structure:**
  ```typescript
  entryPoints: {
    'app-web': './apps/web/src/main.ts',
    'app-mobile': './apps/mobile/src/main.ts',
    'lib-shared': './libs/shared/src/index.ts'
  }
  ```

### `configs` {#configs}

- **Type**: `Record<string, string>`
- **Default**: `{}`
- **Description**: Selects an additional Sheriff config for an explicitly
  mapped workspace directory. This opt-in model keeps existing workspaces
  unchanged, even if nested `sheriff.config.ts` files already exist.

The keys are workspace-relative directories and the values are config paths,
relative to the workspace root or absolute. Matching happens at directory
boundaries, so `apps/a` does not match `apps/ab`. If mappings overlap, the
deepest matching directory wins. Files outside all mappings use the root
config. Absolute directory keys and keys that escape the workspace root are
invalid.

```typescript
export const config: SheriffConfig = {
  entryPoints: {
    hexagonal: './apps/hexagonal-demo/src/main.ts',
    vertical: './apps/vertical-demo/src/main.ts',
  },
  configs: {
    'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
    'apps/vertical-demo': './apps/vertical-demo/sheriff.config.ts',
  },
  modules: {
    // Modules outside the mapped applications use this root config.
  },
  depRules: {},
};
```

Sheriff resolves the config after finding the root config and before parsing
an entry point. ESLint therefore resolves it independently for every linted
file. The CLI resolves it independently for every `entryPoints` value and
prints the selected config in `list` and `verify` output when `configs` is in
use.

Sub-config `modules` keys are still workspace-root-relative, not relative to
the sub-config file:

```typescript
// apps/demo/sheriff.config.ts
export const config: SheriffConfig = {
  modules: {
    'apps/demo/src/domain/<domain>': ['domain:<domain>'],
  },
  depRules: {
    '*': '*',
  },
};
```

Only the root config's `configs`, `entryFile`, and `entryPoints` are used for
selection. The same fields inside a sub-config are ignored after that sub-config
has been selected.

##### A sub-config is standalone

:::warning
A sub-config is **not** merged with the root config. It is merged with
Sheriff's **defaults**, exactly like a root config would be. Every
workspace-wide option must therefore be repeated in every sub-config —
otherwise it silently reverts to its default for everything that sub-config
governs, and `sheriff verify` still reports success.
:::

The trap, written out. The root config below turns on barrel-less mode and
forbids barrels workspace-wide:

```typescript
// sheriff.config.ts
export const config: SheriffConfig = {
  configs: {
    'apps/demo': './apps/demo/sheriff.config.ts',
  },
  enableBarrelLess: true,
  barrelPolicy: 'forbid',
  moduleIdentity: 'config',
  depRules: { '*': '*' },
};
```

❌ **Before** — the sub-config looks harmless, but `apps/demo` runs on
`enableBarrelLess: false`, `barrelPolicy: 'allow'` and
`moduleIdentity: 'auto'`. Barrel-less encapsulation is not enforced there, and
a stray `index.ts` still creates modules:

```typescript
// apps/demo/sheriff.config.ts
export const config: SheriffConfig = {
  modules: {
    'apps/demo/src/domain/<domain>': ['domain:<domain>'],
  },
  depRules: { '*': '*' },
};
```

✅ **After** — the workspace-wide options are repeated, so `apps/demo` is
governed by the same rules as the rest of the workspace:

```typescript
// apps/demo/sheriff.config.ts
export const config: SheriffConfig = {
  enableBarrelLess: true,
  barrelPolicy: 'forbid',
  moduleIdentity: 'config',
  modules: {
    'apps/demo/src/domain/<domain>': ['domain:<domain>'],
  },
  depRules: { '*': '*' },
};
```

The options which need repeating are the ones that shape the whole workspace:
[`enableBarrelLess`](#enablebarrelless), [`moduleIdentity`](#moduleidentity),
[`barrelPolicy`](#barrelpolicy), [`allowBarrelsIn`](#allowbarrelsin),
[`encapsulationPattern`](#encapsulationpattern),
[`barrelFileName`](#barrelfilename), [`excludeRoot`](#excluderoot) and
[`autoTagging`](#autotagging).

Setting an option in a sub-config to the same value as the default is a
deliberate choice and stays fine. To find the ones you forgot, run
[`npx sheriff doctor`](./cli.md#doctor): it reports every option where the
root config sets a non-default value and a sub-config does not set the option
at all.

An import graph initialized from one entry point currently keeps that entry
point's config for the complete traversal. Use separate `entryPoints` for
architectures with separate configs. Applying different configs inside one
cross-boundary traversal requires a future mixed-config project graph; this is
tracked on the roadmap.

### Other Options

#### `plugins` {#plugins}

- **Type**: `SheriffPlugin[]`
- **Default**: `undefined`
- **Description**: Registers additional Sheriff CLI commands by instantiating plugins directly in `sheriff.config.ts`.

:::note
Plugins are only loaded from the root `sheriff.config.ts`. A `plugins` entry in a sub-config referenced via [`configs`](#configs) is ignored.
:::

**Example:**

```typescript
import { SheriffConfig } from '@lambda-solutions/sheriff-core';
import { JunitReporterPlugin } from 'mberger-junit-sheriff';
import { SheriffUiPlugin } from '@lambda-solutions/sheriff-ui';

export const config: SheriffConfig = {
  version: 1,
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

#### `autoTagging` {#autotagging}

- **Type**: `boolean`
- **Default**: `true`
- **Description**: When enabled, Sheriff automatically detects modules and assigns the `noTag` tag to them. Useful for initial setup, but becomes optional when you define explicit `modules`.

#### `enableBarrelLess` {#enablebarrelless}

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enables barrel-less modules where files are directly available except those in the `internal` folder.

#### `barrelPolicy` {#barrelpolicy}

- **Type**: `'allow' | 'warn' | 'forbid'`
- **Default**: `'allow'`
- **Description**: Only effective with `enableBarrelLess: true`. Controls whether barrel files (`index.ts`, or the configured `barrelFileName`) are allowed inside the module tree.

In barrel-less mode the absence of a barrel file is load-bearing configuration: a single stray `index.ts` — created by an IDE, a schematic, or habit — silently turns a barrel-less module into a barrel module and changes its encapsulation semantics.

- `'allow'` (default): keeps the current behaviour, barrels stay legal.
- `'warn'`: observation phase, surfaced by `sheriff verify` only — it prints a warning line for every barrel module (and a warning-aware success line) but still exits successfully. The `barrel-policy` ESLint rule stays silent.
- `'forbid'`: every barrel module becomes a violation — the `barrel-policy` ESLint rule reports on the barrel file, and `sheriff verify` exits with a non-zero code.

Teams that want editor visibility during an observation phase can set `barrelPolicy: 'forbid'` and downgrade the rule severity in their ESLint config instead: `'@lambda-solutions/sheriff/barrel-policy': 'warn'`.

Setting `barrelPolicy` to `'warn'` or `'forbid'` without `enableBarrelLess: true` is a configuration error, because the policy would silently have no effect.

```typescript
export const config: SheriffConfig = {
  enableBarrelLess: true,
  barrelPolicy: 'forbid',
  // ... other configuration
};
```

Intentional barrels can be excluded via [`allowBarrelsIn`](#allowbarrelsin).

#### `allowBarrelsIn` {#allowbarrelsin}

- **Type**: `string[]`
- **Default**: `[]`
- **Description**: Glob patterns, relative to the project root and matched against the module path, for barrel modules that stay legal despite a restrictive `barrelPolicy`. `**` matches any number of path segments; `*` matches within a single segment. Leading and trailing path separators in a pattern are ignored, so `src/api/` behaves like `src/api`.

Use this for intentional bucket-level barrels, e.g. an `api` folder whose `index.ts` acts as a port with a short import path:

```typescript
export const config: SheriffConfig = {
  enableBarrelLess: true,
  barrelPolicy: 'forbid',
  allowBarrelsIn: ['**/api'],
  // ... other configuration
};
```

With this configuration, `libs/domains/booking/src/api/index.ts` stays legal while a library-level barrel such as `libs/domains/booking/src/index.ts` is still flagged.

Setting a non-empty `allowBarrelsIn` while `barrelPolicy` is absent or `'allow'` is a configuration error, because the exceptions would be dead configuration. An explicitly set empty array (`allowBarrelsIn: []`) is legal — it simply keeps the defaults.

#### `moduleIdentity` {#moduleidentity}

- **Type**: `'auto' | 'config'`
- **Default**: `'auto'`
- **Description**: Decides what makes a directory a module.

By default a directory becomes a module in two independent ways: it matches a [`modules`](#modules) pattern, **or** it simply contains a barrel file. The second way means module identity is derived from a file existing. Dropping a stray `index.ts` into a directory that no `modules` pattern covers creates a brand-new, untagged (`noTag`) module and re-routes which module — and therefore which tags — an import is attributed to. The layer matrix silently stops governing that code path.

- `'auto'` (default): `modules` **and** barrel files both create modules.
- `'config'`: only directories matching a `modules` pattern are modules. A barrel file never creates one. Files inside a barrel directory which is not a configured module belong to their nearest enclosing configured module.

```typescript
export const config: SheriffConfig = {
  enableBarrelLess: true,
  moduleIdentity: 'config',
  modules: {
    'libs/domains/<domain>/src/api': ['domain:<domain>', 'type:api'],
    'libs/domains/<domain>/src/data': ['domain:<domain>', 'type:data'],
    'libs/domains/<domain>/src/ui': ['domain:<domain>', 'type:ui'],
  },
  // ... other configuration
};
```

With this configuration, a stray `libs/domains/booking/src/index.ts` no longer creates a module: `libs/domains/booking/src/booking.routes.ts` keeps the module — and the tags — it had before the file appeared.

Setting `moduleIdentity: 'config'` without `enableBarrelLess: true` is a configuration error (`SH-021`), because without barrel-less mode modules are defined by barrel files by definition.

##### What it looks like

Take the configuration above and a `ui` bucket which has grown a sub-folder — an everyday refactoring, and legal: `widgets/` is simply part of the `ui` module.

```
libs/domains/booking/src/ui/booking-card.ts
libs/domains/booking/src/ui/widgets/booking-badge.ts
```

`npx sheriff verify` reports `No issues found. Well done!`.

Now a single file appears, from an IDE, a schematic, or habit:

```typescript
// libs/domains/booking/src/ui/widgets/index.ts
export { BookingBadge } from './booking-badge';
```

With `moduleIdentity: 'auto'`, `npx sheriff list` shows a module nobody configured:

```
├── ui (domain:booking, type:ui)
  └── widgets (noTag)
```

and `verify` reports four violations across three files:

```
|-- libs/domains/booking/src/ui/booking-card.ts
|   |-- Encapsulation Violations
|   |   |-- ./widgets/booking-badge
|   |-- Dependency Rule Violations
|   |   |-- from tag domain:booking to tags noTag
|-- libs/domains/booking/src/ui/widgets/booking-badge.ts
|   |-- Dependency Rule Violations
|   |   |-- from tag noTag to tags domain:booking, type:types
|-- libs/domains/booking/src/ui/widgets/index.ts
|   |-- Barrel Policy Violations
|   |   |-- index.ts turns a barrel-less module into a barrel module ...
```

Two of those files were never touched. They are reported because the layer matrix is now being evaluated against a module that does not exist in the architecture: `domain:booking` importing `noTag`, and `noTag` importing back.

With `moduleIdentity: 'config'` and the very same file tree, `sheriff list` is unchanged — there is no `widgets` node — and `verify` reports one violation, on the file that actually causes it:

```
  Total Encapsulation Violations: 0
  Total Dependency Rule Violations: 0
  Total Barrel Policy Violations: 1

|-- libs/domains/booking/src/ui/widgets/index.ts
|   |-- Barrel Policy Violations
|   |   |-- index.ts sits outside any module configured via `modules`.
|   |   |   With moduleIdentity: 'config' it creates no module and has no
|   |   |   effect on encapsulation. Remove it, add its directory to
|   |   |   `modules`, or add it to `allowBarrelsIn`.
```

The rest of the code is judged by its configured identity again, and the remaining message names the cause and the ways out. This scenario is pinned end-to-end by the `nx-i` integration project.

##### Barrels still decide exposure

`moduleIdentity` changes module **identity**, not module **exposure**. Inside a configured module a barrel file still means "only this file is importable from outside":

- A configured module containing a barrel file keeps its path, its tags and its dependency rules, but exposes only the barrel file.
- The barrel takes precedence over a module's [`exports`](#exports): where both are present, the barrel alone decides what is importable — exactly as in `'auto'` mode.

This residual blast radius is what [`barrelPolicy`](#barrelpolicy) reports. Under `moduleIdentity: 'config'` the policy also reports barrel files which sit outside every configured module — otherwise the case this option exists to defuse would become invisible to `sheriff verify`. Those barrels obey `allowBarrelsIn` in the same way, matched against their directory.

##### Migration

`'auto'` is the default and unchanged, so existing projects are unaffected. Switching to `'config'` is behavior-changing:

- **Modules disappear.** Every module that existed only because of a barrel file, without a matching `modules` entry, is gone. Its files move to the nearest enclosing configured module (or to the root module). Run `npx sheriff list` before and after to see the difference.
- **Tags and dependency rules move with them.** Files that were governed by `noTag` rules are now governed by the enclosing module's tags. If you relied on `noTag: noDependencies` as a tripwire, the tripwire moves.
- **Encapsulation relaxes for those directories.** A barrel that no longer creates a module no longer restricts imports into its directory; the enclosing module's rules apply instead. Where that enclosing module is the **root module**, there are effectively no encapsulation restrictions on those files at all: `moduleIdentity: 'config'` requires `enableBarrelLess: true`, and a barrel-less root module exposes every file that does not match the [`encapsulationPattern`](#encapsulationpattern). Such files then become deep-importable from anywhere, and [`excludeRoot`](#excluderoot) makes no difference to that — it only relaxes access to the root module, which is already fully exposed. Add a `modules` entry for those directories if you want them to stay encapsulated.

The recommended path is to run `npx sheriff doctor` first, add a `modules` entry for every barrel module you want to keep, and only then switch `moduleIdentity` to `'config'`.

#### `encapsulationPattern` {#encapsulationpattern}

- **Type**: `string | RegExp`
- **Default**: `'internal'`
- **Description**: Pattern for files that are not available outside their barrel-less module. A string encapsulates a file when the module-relative path starts with the pattern, or when any directory segment of the path equals the pattern exactly — so an `internal` folder is encapsulated at any depth of the module (e.g. `data/foo/internal/secret.ts`). The filename itself does not count as a segment: `data/internal.ts` stays public, while a top-level `internal.ts` remains encapsulated via the prefix rule. A string pattern containing a path separator (e.g. `'internal/'` or `'sub/internal'`) can never equal a single directory segment and therefore only gets the legacy prefix behavior. A regular expression is matched against the module-relative path. `exports` of a module definition take precedence over this pattern.

#### `barrelFileName` {#barrelfilename}

- **Type**: `string`
- **Default**: `'index.ts'`
- **Description**: Name of the barrel file that exports public APIs from a module.

#### `ignoreFileExtensions` {#ignorefileextensions}

- **Type**: `string[] | ((defaults: string[]) => string[])`
- **Default**: See [Default Ignored Extensions]
- **Description**: Controls which file extensions are ignored during import traversal. Sheriff will not follow imports to files with these extensions.

<details>
<summary>Default Ignored Extensions</summary>

**Default Ignored Extensions:**

- **Images**: `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`
- **Styles**: `css`, `scss`, `sass`, `less`
- **Fonts**: `woff`, `woff2`, `ttf`, `eot`, `otf`
- **Audio**: `mp3`, `wav`, `ogg`
- **Video**: `mp4`, `webm`, `mov`
- **Data/Misc**: `json`, `csv`, `xml`, `txt`, `md`

</details>

### Legacy Options

#### `excludeRoot` {#excluderoot}

- **Type**: `boolean`
- **Default**: `false`
- **Description**: When enabled, removes the implicit root project from all checks. Useful for incremental integration of Sheriff into existing applications.

#### `log` {#log}

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enables detailed logging for debugging purposes.

#### `version` {#version}

- **Type**: `number`
- **Default**: `1`
- **Description**: Configuration version. Currently only version 1 is supported. This option is rarely needed as Sheriff automatically uses the latest supported version.

## Configuration Validation

Sheriff validates your configuration and will throw helpful errors if:

- Both `entryFile` and `entryPoints` are specified
- `autoTagging` is disabled but no `modules` are defined
- Invalid dependency rules are configured
- Required properties are missing

## Migration from Previous Versions

If you're upgrading from an older version of Sheriff, check the [Release Notes](./release-notes/) for any breaking changes or new configuration options.

Generally speaking, we really try hard to avoid breaking changes.
