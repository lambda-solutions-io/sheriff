import { FsPath } from '../file-info/fs-path';

export interface DependencyCheckContext {
  /** Path of the importing module. */
  fromModulePath: FsPath;
  /** Path of the imported module. */
  toModulePath: FsPath;
  /** Path of the importing file. */
  fromFilePath: FsPath;
  /** Path of the resolved imported file. */
  toFilePath: FsPath;
  fromTags: string[];
  toTags: string[];
}

export type RuleMatcherFn = (
  context: { from: string; to: string } & DependencyCheckContext,
) => boolean;

export type RuleMatcher = string | null | RuleMatcherFn;
export type DependencyRulesConfig = Record<string, RuleMatcher | RuleMatcher[]>;

/**
 * Context handed to an {@link ExternalRuleMatcherFn}.
 *
 * `from` is the tag of the importing module which matched the rule's key,
 * `externalLibrary` is the raw import string of the package, e.g.
 * `@angular/core` or `@angular/core/testing`.
 */
export interface ExternalCheckContext {
  from: string;
  fromTags: string[];
  fromModulePath: FsPath;
  fromFilePath: FsPath;
  externalLibrary: string;
}

/**
 * Returns `true` if the external import is allowed for the given tag.
 */
export type ExternalRuleMatcherFn = (context: ExternalCheckContext) => boolean;

/**
 * Rules for imports coming from `node_modules`.
 *
 * Keys are matched (wildcard-aware) against the importing module's tags.
 * Values are wildcard patterns matched against the full import string, or a
 * matcher function.
 */
export type ExternalRulesConfig = Record<
  string,
  string[] | ExternalRuleMatcherFn
>;
