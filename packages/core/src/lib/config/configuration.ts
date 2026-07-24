import { UserSheriffConfig } from './user-sheriff-config';

/**
 * Provenance record for a single module loaded while evaluating
 * `sheriff.config.ts`.
 *
 * Sheriff transpiles the config file and evaluates it in-process. Every
 * `import` in the config therefore resolves through Node's `require` against
 * the **built** output in `node_modules` — not against the package sources.
 * `ConfigImport` captures which build was actually loaded so a stale `dist`
 * becomes visible instead of being enforced silently.
 *
 * Note: because of the evaluation context, specifiers resolve relative to the
 * Sheriff core package, not relative to the config file's location.
 */
export type ConfigImport = {
  /** The import specifier exactly as written in `sheriff.config.ts`. */
  specifier: string;
  /**
   * The path returned by `require.resolve(specifier)`. Empty when the
   * specifier could not be resolved (see {@link ConfigImport#error}).
   */
  resolvedPath: string;
  /**
   * The canonical path of {@link ConfigImport#resolvedPath} with symlinks
   * resolved. For pnpm-/workspace-linked packages this reveals which
   * workspace build is actually running. Empty when resolution failed.
   */
  realPath: string;
  /**
   * The resolution error message. Only present when the specifier failed to
   * resolve; `resolvedPath` and `realPath` are empty in that case.
   */
  error?: string;
};

export type Configuration = Required<
  Omit<
    UserSheriffConfig,
    | 'tagging'
    | 'showWarningOnBarrelCollision'
    | 'encapsulatedFolderNameForBarrelLess'
    | 'entryPoints'
    | 'plugins'
  >
> & {
  // dependency rules will skip if `isConfigFileMissing` is true
  isConfigFileMissing: boolean;
  /**
   * entryPoints is the merger of the entry file and the entry points
   * from the user's config
   */
  entryPoints?: Record<string, string>;
  // ignoreFileExtensions is always present (either user-specified or default)
  ignoreFileExtensions: string[];
  plugins?: UserSheriffConfig['plugins'];
  /**
   * Provenance of every module the config file loaded during evaluation, in
   * require order. Purely informational: it has no effect on rule
   * evaluation. Empty when the config has no runtime imports.
   */
  configImports: ConfigImport[];
};
