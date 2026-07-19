import { violatesEncapsulationRule } from '@lambda-solutions/sheriff-core';
import { daemonEncapsulationMessage } from '../daemon-bridge/daemon-lint-cache';
import { createRule } from './create-rule';

export const encapsulation = createRule(
  'Encapsulation',
  (context, node, isFirstRun, filename, sourceCode) => {
    const importValue = (node.source as { value: string }).value;
    const daemonMessage = daemonEncapsulationMessage(
      filename,
      importValue,
      isFirstRun,
      sourceCode,
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

    const message = violatesEncapsulationRule(
      filename,
      importValue,
      isFirstRun,
      sourceCode,
      false
    );
    if (message) {
      context.report({
        message,
        node,
      });
    }
  },
);
