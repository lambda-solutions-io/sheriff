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

An import graph initialized from one entry point currently keeps that entry
point's config for the complete traversal. Use separate `entryPoints` for
architectures with separate configs. Applying different configs inside one
cross-boundary traversal requires a future mixed-config project graph; this is
tracked on the roadmap.

### Other Options

#### `autoTagging` {#autotagging}

- **Type**: `boolean`
- **Default**: `true`
- **Description**: When enabled, Sheriff automatically detects modules and assigns the `noTag` tag to them. Useful for initial setup, but becomes optional when you define explicit `modules`.

#### `enableBarrelLess` {#enablebarrelless}

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enables barrel-less modules where files are directly available except those in the `internal` folder.

#### `encapsulationPattern` {#encapsulationpattern}

- **Type**: `string`
- **Default**: `'internal'`
- **Description**: Name of the folder that contains encapsulated files not available outside the module.

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
