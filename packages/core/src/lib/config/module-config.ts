// https://stackoverflow.com/questions/42123407/does-typescript-support-mutually-exclusive-types/53229567#53229567
type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };
export type XOR<T, U> = T | U extends object
  ? (Without<T, U> & U) | (Without<U, T> & T)
  : T | U;

export interface MatcherContext {
  segment: string;
  regexMatch?: RegExpMatchArray | null;
}

export type TagMatcherFn<ReturnType extends string | string[]> = (
  placeholders: Record<string, string>,
  context: MatcherContext,
) => ReturnType;

export interface SingleTag {
  tag?: string | TagMatcherFn<string>;
}

export interface MultiTags {
  tags?: string[] | TagMatcherFn<string[]>;
}

export type TagConfigValue =
  | string
  | string[]
  | TagMatcherFn<string[] | string>;

/**
 * Explicit, object-shaped module declaration.
 *
 * It is distinguishable from a nested {@link ModuleConfig} by the presence of
 * the `tags` property, which a nested `ModuleConfig` can never carry, because
 * its values are path matchers.
 *
 * @example
 * ```typescript
 * modules: {
 *   'domains/booking/api': {
 *     tags: ['type:api', 'port'],
 *     exports: ['*.port.ts'],
 *   },
 * }
 * ```
 */
export interface ModuleDefinition {
  /**
   * The tags assigned to this module.
   */
  tags: TagConfigValue;

  /**
   * Files which are importable from outside the module. Wildcard patterns are
   * matched against the module-relative path of the imported file.
   *
   * Without `exports`, the module behaves as before: everything is public
   * except the encapsulation pattern (`internal` by default).
   */
  exports?: string[];
}

export interface ModuleConfig {
  [pathMatcher: string]: TagConfigValue | ModuleDefinition | ModuleConfig;
}
