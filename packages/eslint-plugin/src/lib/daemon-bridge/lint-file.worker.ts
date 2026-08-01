import { DaemonClient } from '@lambda-solutions/sheriff-core';
import { runAsWorker } from 'synckit';
import type { DaemonLintResult } from './daemon-bridge';

runAsWorker(
  async (
    rootDir: string,
    filename: string,
    fileContent: string,
  ): Promise<DaemonLintResult> => {
    const client = await DaemonClient.connect(rootDir, {
      throwOnVersionMismatch: true,
    });
    if (!client) {
      throw new Error('sheriff daemon unreachable');
    }

    try {
      return (await client.request('lintFile', {
        filename,
        fileContent,
      })) as DaemonLintResult;
    } finally {
      client.close();
    }
  },
);
