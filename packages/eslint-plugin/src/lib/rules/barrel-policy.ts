import { violatesBarrelPolicy } from '@lambda-solutions/sheriff-core';
import { createRule } from './create-rule';

/**
 * Reports on the barrel file itself when it violates the configured
 * `barrelPolicy` (barrel-less mode with `'warn'` or `'forbid'` and the
 * module is not excluded via `allowBarrelsIn`).
 *
 * The check is per file, not per import, so it only runs on the first
 * traversed import/export node of the linted file.
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
);
