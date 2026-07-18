import {
  DependencyCheckContext,
  DependencyRulesConfig,
} from '../config/dependency-rules-config';
import { wildcardToRegex } from '../util/wildcard-to-regex';

/**
 * Returns `true` if a `denyRule` forbids the dependency.
 *
 * Unlike `isDependencyAllowed`, a tag without a matching rule is normal and
 * never raises `NoDependencyRuleForTagError`. A `denyRules` hit always wins
 * over any `depRules` match — deny beats allow.
 *
 * `denyRules` keys are OR-combined: any matching key can deny the dependency.
 */
export const isDependencyDenied = (
  from: string,
  config: DependencyRulesConfig,
  context: DependencyCheckContext,
): boolean => {
  for (const tag in config) {
    if (!from.match(wildcardToRegex(tag))) {
      continue;
    }

    for (const to of context.toTags) {
      const value = config[tag];
      const matchers = Array.isArray(value) ? value : [value];

      for (const matcher of matchers) {
        if (
          typeof matcher === 'string' &&
          to.match(wildcardToRegex(matcher))
        ) {
          return true;
        } else if (
          typeof matcher === 'function' &&
          matcher({
            ...context,
            from,
            to,
          })
        ) {
          return true;
        }
      }
    }
  }

  return false;
};
