import { violatesBarrelPolicy } from '@lambda-solutions/sheriff-core';
import { createRule } from './create-rule';

/**
 * Reports on the barrel file itself when it violates
 * `barrelPolicy: 'forbid'` (barrel-less mode and the module is not excluded
 * via `allowBarrelsIn`). `'warn'` is verify-only and never reported here.
 *
 * The check is per file, not per import: it runs once on the `Program`
 * node, so even an empty stray barrel file is reported when linted.
 */
export const barrelPolicy = createRule(
  'Barrel Policy',
  (context, node, isFirstRun, filename, sourceCode) => {
    if (!isFirstRun) {
      return;
    }

    const message = violatesBarrelPolicy(filename, sourceCode);
    if (message) {
      context.report({
        message,
        node,
      });
    }
  },
  { checkOnProgramNode: true },
);
