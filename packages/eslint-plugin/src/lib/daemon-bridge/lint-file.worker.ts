import { DaemonClient } from '@lambda-solutions/sheriff-core';
import { runAsWorker } from 'synckit';
import type { DaemonLintResult } from './daemon-bridge';

type LintFileHandler = (
  rootDir: string,
  filename: string,
  fileContent: string,
) => Promise<DaemonLintResult>;

const CONNECTION_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ENOTCONN',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as NodeJS.ErrnoException;
  return (
    error.message === 'daemon connection closed' ||
    (errorWithCode.code !== undefined &&
      CONNECTION_ERROR_CODES.has(errorWithCode.code))
  );
}

/** Creates the per-worker handler with a lazily retained daemon connection. */
export function createLintFileHandler(): LintFileHandler {
  let client: DaemonClient | undefined;
  let clientRootDir: string | undefined;

  const discardClient = (discardedClient: DaemonClient): void => {
    discardedClient.close();
    if (client === discardedClient) {
      client = undefined;
      clientRootDir = undefined;
    }
  };

  const getClient = async (rootDir: string): Promise<DaemonClient> => {
    if (client && clientRootDir === rootDir) {
      return client;
    }

    if (client) {
      discardClient(client);
    }

    const connectedClient = await DaemonClient.connect(rootDir);
    if (!connectedClient) {
      throw new Error('sheriff daemon unreachable');
    }
    client = connectedClient;
    clientRootDir = rootDir;
    return connectedClient;
  };

  return async (
    rootDir: string,
    filename: string,
    fileContent: string,
  ): Promise<DaemonLintResult> => {
    const request = async (requestClient: DaemonClient) =>
      (await requestClient.request('lintFile', {
        filename,
        fileContent,
      })) as DaemonLintResult;

    const activeClient = await getClient(rootDir);
    try {
      return await request(activeClient);
    } catch (error) {
      if (!isConnectionFailure(error)) {
        throw error;
      }
      discardClient(activeClient);
    }

    const replacementClient = await getClient(rootDir);
    try {
      return await request(replacementClient);
    } catch (error) {
      if (isConnectionFailure(error)) {
        discardClient(replacementClient);
      }
      throw error;
    }
  };
}

runAsWorker(createLintFileHandler());
