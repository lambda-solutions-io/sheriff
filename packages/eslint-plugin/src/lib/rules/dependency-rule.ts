import { violatesDependencyRule } from '@lambda-solutions/sheriff-core';
import { daemonDependencyMessage } from '../daemon-bridge/daemon-lint-cache';
import { createRule } from './create-rule';

export const dependencyRule = createRule(
  'Dependency Rule',
  (context, node, isFirstRun, filename, sourceCode, lintRun) => {
    const importValue = (node.source as { value: string }).value;
    const daemonMessage = daemonDependencyMessage(
      filename,
      importValue,
      isFirstRun,
      sourceCode,
      lintRun,
    );
    if (daemonMessage !== undefined) {
      if (daemonMessage) {
        context.report({
          message: daemonMessage,
          node,
        });
      }
      return;
    }

    const message = violatesDependencyRule(
      filename,
      importValue,
      isFirstRun,
      sourceCode,
    );
    if (message) {
      context.report({
        message,
        node,
      });
    }
  },
);
