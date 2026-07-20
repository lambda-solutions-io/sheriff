import { violatesEncapsulationRule } from '@lambda-solutions/sheriff-core';
import { daemonDeepImportMessage } from '../daemon-bridge/daemon-lint-cache';
import { createRule } from './create-rule';

export const deepImport = createRule(
  'Deep Import',
  (context, node, isFirstRun, filename, sourceCode, lintRun) => {
    const importValue = (node.source as { value: string }).value;
    const daemonMessage = daemonDeepImportMessage(
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

    const message = violatesEncapsulationRule(
      filename,
      importValue,
      isFirstRun,
      sourceCode,
      true,
    );
    if (message) {
      context.report({
        message,
        node,
      });
    }
  },
);
