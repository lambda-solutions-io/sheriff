import { ModuleConfig } from './module-config';
import {
  DependencyRulesConfig,
  ExternalRulesConfig,
} from './dependency-rules-config';
import { SheriffPlugin } from '../plugin/plugin';

/**
 * Exported by **sheriff.config.ts**. It is optional and should be located
 * in the project's root directory.
 *
 * If it does not exist, only the deep-import rule is active.
 *
 * ## Examples:
 *
 * __Classic layered architecture__
 *
 * ```typescript
 * import { SheriffConfig } from '@lambda-solutions/sheriff-core';
 *
 * export const config: SheriffConfig = {
 *   modules: {
 *     src: {
 *       db: 'db',
 *       logic: 'logic',
 *       ui: 'ui'
 *     }
 *   },
 *   depRules: {
 *     ui: 'logic',
 *     logic: 'db'
 *   }
 * }
 * ```
 *
 * __Angular CLI with feature modules and placeholders__
 *
 * ```typescript
 * import { anyTag, SheriffConfig } from '@lambda-solutions/sheriff-core';
 *
 * export const config: SheriffConfig = {
 *   modules: {
 *     'src/app': {
 *       'feature/<feature>': 'feature:<feature>',
 *       'shared': 'shared'
 *     }
 *   },
 *   depRules: {
 *     'feature:*': 'shared'
 *   }
 * }
 * ```
 */
export interface UserSheriffConfig {
  /**
   * Tagging is not mandatory, if autoTagging is enabled (by default).
   *
   * @deprecated Use `modules` instead.
   */
  tagging?: ModuleConfig;

  /**
   * Defines the modules and their associated tags.
   *
   * Expects an object where keys represent the module paths, and each module
   * requires one or more tags.
   *
   * __Example:__
   *
   * Given a project structure where `feature-1` and `feature-2` are modules:
   *
   * <pre>
   * main.ts
   * feature-1
   *   ├── feature1.ts
   *   └── internal
   *       ├── client.ts
   *       └── services.ts
   * feature-2
   *   ├── feature2.ts
   *   └── internal
   *       └── feature2-helper.ts
   * </pre>
   *
   * The configuration for `modules` would look like this:
   *
   * ```typescript
   * {
   *   modules: {
   *     'feature-1': ['type:feature', 'scope:global'],
   *     'feature-2': 'type:feature2'
   *   }
   * }
   * ```
   *
   * In this example, the `internal` folder encapsulates files, meaning they are
   * not accessible outside the module.
   *
   * The assigned tags can also be used to enforce dependency rules, {@link #depRules}.
   *
   * If the {@link #autoTagging} property is enabled, the `modules` configuration is optional.
   */
  modules?: ModuleConfig;

  /**
   * Assigns the tag "**noTag**" to all untagged barrel-modules (modules with an `index.ts`).
   * Set to `true` by default.
   */
  autoTagging?: boolean;

  depRules: DependencyRulesConfig;

  /**
   * Rules that FORBID dependencies. A matching `denyRule` always wins over any
   * `depRules` match — deny beats allow, regardless of key order.
   *
   * Use this when a tag must restrict, not widen: `depRules` keys are
   * OR-combined, so a module carrying several tags can only ever gain
   * clearance, never lose it.
   *
   * A tag without a `denyRules` entry is normal and does not raise
   * `NoDependencyRuleForTagError`. `denyRules` alone never allows anything.
   *
   * @example
   * ```typescript
   * denyRules: {
   *   'type:domain': ({ to }) => to !== 'type:domain',
   * }
   * ```
   */
  denyRules?: DependencyRulesConfig;

  /**
   * Rules for imports from `node_modules` (external libraries). Keys are
   * matched against the importing module's tags; values are wildcard patterns
   * matched against the package import string.
   *
   * A tag without an entry is unrestricted — external imports stay allowed by
   * default, so existing projects are unaffected. An empty array forbids every
   * external import for that tag.
   *
   * @example
   * ```typescript
   * externalRules: {
   *   'type:domain': [],                     // core: no external deps
   *   'type:api': ['@angular/core'],         // ports: DI tokens only
   *   'type:infra': ['@angular/*', 'rxjs'],  // adapters: may use anything
   * }
   * ```
   */
  externalRules?: ExternalRulesConfig;

  /**
   * Additional Sheriff configs which apply to a sub-tree of the workspace.
   * Keys are workspace-relative directories, values are paths to the config
   * file which governs that directory.
   *
   * The most specific (deepest) matching entry wins; files not covered by any
   * entry keep using the root config. Sub-config `modules` keys remain
   * workspace-root-relative. A sub-config's own `configs`, `entryFile`, and
   * `entryPoints` fields are ignored; only the root config selects configs and
   * entry points.
   *
   * @example
   * ```typescript
   * configs: {
   *   'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
   * }
   * ```
   */
  configs?: Record<string, string>;

  // optional property. Has the value `1` by default.
  version?: number;
  /**
   * Remove the implicit root project from all checks. Useful for an
   * incremental integration of Sheriff into an existing application.
   *
   * The root project is implicitly generated, if the project's
   * root folder has no **index.ts** and also applies to all
   * its subfolders without **index.ts**.
   *
   * __Example__
   *
   * <pre>
   * - main.ts
   * - router.ts
   * - config.ts
   * shared
   *   - get.ts
   *   - dialog.ts
   *   - index.ts
   * customers
   *   - customer-component.ts
   * holidays
   *   - holidays-component.ts
   *   - holidays-loader.ts
   * </pre>
   *
   * In this example, **./shared** has an **index.ts** and acts as module.
   * The rest is part of the implicit root app.
   *
   * Without `excludeRoot` (default set to `false`), all files within
   * **./shared** cannot import from root. Files from root can import
   * from **./shared** following the rules for deep-import dependencies rules.
   *
   * With `excludeRoot: true`, **./shared** can directly access any file
   * from root. deep-import and dependencies rules do not apply.
   *
   * As for the configuration, you can use this example:
   *
   * ```typescript
   * export const config: SheriffConfig = {
   *   excludeRoot: true,
   *   modules: {
   *     "src/shared": "shared",
   *   },
   *   depRules: {
   *     "*": () => true
   *   }
   * }
   * ```
   */
  excludeRoot?: boolean;

  /**
   * The barrel file is usually the `index.ts` and exports
   * those files which are available outside the module.
   */
  barrelFileName?: string;

  /**
   * The barrel-less approach means that the module
   * does not have an `index.ts` file. Instead, all files
   * are directly available, except those which are located
   * in a special folder ("internal" be default).
   */
  enableBarrelLess?: boolean;

  /**
   * Only effective with {@link enableBarrelLess}: controls whether barrel
   * files (`index.ts`, or the configured {@link barrelFileName}) are allowed
   * inside the module tree.
   *
   * In barrel-less mode the absence of a barrel file is load-bearing
   * configuration: a single stray `index.ts` silently turns a barrel-less
   * module into a barrel module and changes its encapsulation semantics.
   *
   * - `'allow'` (default): keeps the current behaviour, barrels stay legal.
   * - `'warn'`: observation phase, surfaced by `sheriff verify` only — it
   *   prints a warning line for every barrel module but still exits
   *   successfully. The ESLint rule stays silent.
   * - `'forbid'`: every barrel module becomes a violation — the
   *   `barrel-policy` ESLint rule reports on the barrel file and
   *   `sheriff verify` exits with a non-zero code.
   *
   * Intentional barrels can be excluded via {@link allowBarrelsIn}.
   *
   * Setting `barrelPolicy` to `'warn'` or `'forbid'` without
   * `enableBarrelLess: true` is an error, because the policy would silently
   * have no effect.
   *
   * @example
   * ```typescript
   * export const config: SheriffConfig = {
   *   enableBarrelLess: true,
   *   barrelPolicy: 'forbid',
   *   // ... other configuration
   * };
   * ```
   */
  barrelPolicy?: 'allow' | 'warn' | 'forbid';

  /**
   * Decides what makes a directory a module.
   *
   * By default a directory becomes a module in two independent ways: it
   * matches a {@link modules} pattern, or it simply contains a barrel file.
   * The second way means module identity is derived from a file existing —
   * dropping one stray `index.ts` into a directory that no `modules` pattern
   * covers creates a brand-new, untagged (`noTag`) module and re-routes which
   * module (and therefore which tags) an import is attributed to. The layer
   * matrix silently stops governing that code path.
   *
   * - `'auto'` (default): keeps that behaviour — `modules` **and** barrel
   *   files both create modules.
   * - `'config'`: only directories matching a {@link modules} pattern are
   *   modules. A barrel file never creates one. Files inside a barrel
   *   directory which is not a configured module belong to their nearest
   *   enclosing configured module.
   *
   * With `'config'` a barrel file still decides EXPOSURE *inside* a
   * configured module: a configured module containing a barrel file exposes
   * only that barrel file. The barrel therefore takes precedence over
   * configured `exports` for the same module — exposure is decided by the
   * barrel alone, exactly as in `'auto'` mode. Only identity and tagging
   * change.
   *
   * Because `'config'` is only meaningful when modules are not defined by
   * barrels in the first place, it requires {@link enableBarrelLess} to be
   * `true` and is otherwise rejected (SH-021).
   *
   * @example
   * ```typescript
   * export const config: SheriffConfig = {
   *   enableBarrelLess: true,
   *   moduleIdentity: 'config',
   *   modules: {
   *     'libs/domains/<domain>/src/<type>': ['domain:<domain>', 'type:<type>'],
   *   },
   *   // ... other configuration
   * };
   * ```
   */
  moduleIdentity?: 'auto' | 'config';

  /**
   * Glob patterns, relative to the project root and matched against the
   * module path, for barrel modules that stay legal despite a restrictive
   * {@link barrelPolicy}. `**` matches any number of path segments;
   * leading and trailing path separators in a pattern are ignored.
   *
   * Use this for intentional bucket-level barrels, e.g. an `api` folder
   * whose `index.ts` acts as a port with a short import path.
   *
   * Setting a non-empty `allowBarrelsIn` while `barrelPolicy` is absent or
   * `'allow'` is an error, because the exceptions would be dead
   * configuration. An explicitly set empty array is legal.
   *
   * @example
   * ```typescript
   * export const config: SheriffConfig = {
   *   enableBarrelLess: true,
   *   barrelPolicy: 'forbid',
   *   allowBarrelsIn: ['libs/domains/*\/src/api', '**\/api'],
   *   // ... other configuration
   * };
   * ```
   */
  allowBarrelsIn?: string[];

  /**
   * The encapsulated folder contains all files
   * which are not available outside the module.
   * By default, it is set to `internal`.
   *
   * This option is an alias for {@link encapsulationPattern}:
   * its value is copied onto `encapsulationPattern` and
   * therefore inherits the any-depth directory-segment
   * matching of string patterns.
   *
   * @deprecated use {@link encapsulationPattern} instead
   */
  encapsulatedFolderNameForBarrelLess?: string;

  /**
   * By default, it is set to `internal`, meaning
   * all files within a folder `internal` of
   * a module are encapsulated.
   *
   * You can choose a string value or a regex to
   * define the location/pattern for encapsulation
   * in barrel-less modules.
   *
   * A **string** pattern encapsulates a file if
   *
   * - the module-relative path starts with the pattern, or
   * - any directory segment of the path equals the pattern
   *   exactly — the pattern folder is encapsulated at any
   *   depth of the module. The filename itself does not
   *   count as a segment.
   *
   * A string pattern containing a path separator (e.g.
   * `'internal/'` or `'sub/internal'`) can never equal a
   * single directory segment and therefore only gets the
   * legacy prefix behavior.
   *
   * Examples:
   *
   * ---
   * A **string** `encapsulationPattern: 'private'` encapsulates
   *
   * - `private/main.ts`
   * - `private/sub/sub.ts`
   * - `sub/private/main.ts` (directory segment at any depth)
   * - `privates/main.ts` (prefix match)
   *
   * But would expose
   * - `main.ts`
   * - `sub/private.ts` (a filename is not a directory segment)
   * - `sub/privates/main.ts` (nested segment must match exactly)
   * - `internal/hidden.ts`
   *
   * ---
   *
   * A **regular expression** `encapsulationPattern: /(^|\/)_/` encapsulates
   * any file or directory starting with an underscore:
   *
   * - _main.ts
   * - internal/_hidden
   * - _sub/main.ts
   *
   * But would expose
   *
   * - main.ts
   * - internal/hidden
   * - sub/main_file.ts
   *
   * ---
   */
  encapsulationPattern?: string | RegExp;

  /**
   * @deprecated no warning is shown.
   */
  showWarningOnBarrelCollision?: boolean;

  /**
   * enable internal logging and save it to `sheriff.log`
   */
  log?: boolean;

  /**
   * The file or files that the CLI should use by default.
   *
   * It must only be set for workspaces with one project.
   *
   * @note
   * If you have a multi-project setup, use the `entryPoints` property instead.
   * Either `entryFile` or `entryPoints` can be set, but not both.
   */
  entryFile?: string;

  /**
   * The entry points that the CLI should use by default.
   * This is relevant for a multi-project setup.
   *
   * @example
   * ```typescript
   * entryPoints: {
   *   'app1': 'apps/app1/src/app/main.ts',
   *   'lib-form': 'libs/form/src/lib/main.ts'
   * }
   * ``
   *
   * @note
   * For single-project setups, rather use the `entryFile` property instead.
   * Either `entryFile` or `entryPoints` can be set, but not both.
   */
  entryPoints?: Record<string, string>;

  /**
   * List of file extensions to ignore.
   * Can be either:
   * - An array of strings (replaces defaults completely)
   * - A function that receives the default extensions and returns a new list
   *
   * @example
   * ```typescript
   * // would add 'env' and 'yaml' to the defaults
   * ignoreFileExtensions: (defaults) => [...defaults, 'env', 'yaml']
   * ```
   *
   * @example
   * ```typescript
   * // would override defaults as well
   * ignoreFileExtensions: ['env', 'yaml']
   * ```
   */
  ignoreFileExtensions?: string[] | ((defaults: string[]) => string[]);

  /**
   * Optional Sheriff plugins that extend the CLI with additional commands.
   *
   * Plugins are instantiated directly in `sheriff.config.ts`. Only the root
   * config's plugins are loaded; `plugins` in a sub-config referenced via
   * {@link configs} is ignored.
   */
  plugins?: SheriffPlugin[];
}
