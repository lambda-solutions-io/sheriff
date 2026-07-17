import {
  DependencyCheckContext,
  DependencyRulesConfig,
} from '../config/dependency-rules-config';

/**
 * Returns `true` if a `denyRule` forbids the dependency.
 *
 * Unlike `isDependencyAllowed`, a tag without a matching rule is normal and
 * never raises `NoDependencyRuleForTagError`. A `denyRules` hit always wins
 * over any `depRules` match — deny beats allow.
 *
 * TODO: not implemented yet — see task 1. This is a signature-only stub so
 * that the specs fail on their assertions instead of on a missing module.
 */
export const isDependencyDenied = (
  _from: string,
  _config: DependencyRulesConfig,
  _context: DependencyCheckContext,
): boolean => {
  return false;
};
