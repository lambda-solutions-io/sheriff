import {
  DaemonClient,
  DaemonRequestTimeoutError,
  DaemonTransportError,
} from '@lambda-solutions/sheriff-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDaemonConnection } from './daemon-bridge';
import { handleToolCall, ToolCallOptions } from './tools';

vi.mock('@lambda-solutions/sheriff-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lambda-solutions/sheriff-core')>();
  return {
    // The real error classes and guards, so the bridge's
    // transport-vs-timeout-vs-application distinction is exercised on the
    // same types production uses, not mocked away.
    DaemonTransportError: actual.DaemonTransportError,
    isDaemonTransportError: actual.isDaemonTransportError,
    DaemonRequestTimeoutError: actual.DaemonRequestTimeoutError,
    isDaemonRequestTimeoutError: actual.isDaemonRequestTimeoutError,
    DaemonClient: {
      connect: vi.fn(),
    },
  };
});

describe('Sheriff MCP tool dispatch', () => {
  const cannedResult = { valid: true };
  const request =
    vi.fn<
      (method: string, params?: Record<string, unknown>) => Promise<unknown>
    >();
  const close = vi.fn<() => void>();
  const connect = vi.mocked(DaemonClient.connect);
  const options: ToolCallOptions = {
    rootDir: '/workspace/project',
    cliBinPath: '/workspace/sheriff-cli.js',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDaemonConnection();
    request.mockResolvedValue(cannedResult);
    connect.mockResolvedValue({ request, close } as unknown as DaemonClient);
  });

  afterEach(() => {
    resetDaemonConnection();
  });

  it('maps verify to the verify daemon method', async () => {
    const result = await handleToolCall(
      'verify',
      { entryFile: 'src/main.ts' },
      options,
    );

    expect(request).toHaveBeenCalledWith('verify', {
      entryFile: 'src/main.ts',
    });
    expect(result).toEqual(successResult(cannedResult));
    // The shared connection stays open for reuse across calls.
    expect(close).not.toHaveBeenCalled();
  });

  it('maps getProjectData options to nested daemon options', async () => {
    await handleToolCall(
      'getProjectData',
      {
        entryFile: 'src/main.ts',
        includeExternalLibraries: true,
      },
      options,
    );

    expect(request).toHaveBeenCalledWith('getProjectData', {
      entryFile: 'src/main.ts',
      options: { includeExternalLibraries: true },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('maps getConfig to a daemon request without parameters', async () => {
    await handleToolCall('getConfig', {}, options);

    expect(request).toHaveBeenCalledWith('getConfig');
    expect(close).not.toHaveBeenCalled();
  });

  it('maps lintFile to the lintFile daemon method', async () => {
    await handleToolCall(
      'lintFile',
      {
        filename: 'src/main.ts',
        fileContent: 'export const value = true;',
      },
      options,
    );

    expect(request).toHaveBeenCalledWith('lintFile', {
      filename: 'src/main.ts',
      fileContent: 'export const value = true;',
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('reuses a single connection across concurrent tool calls', async () => {
    const [first, second] = await Promise.all([
      handleToolCall('getConfig', {}, options),
      handleToolCall('verify', {}, options),
    ]);

    expect(first).toEqual(successResult(cannedResult));
    expect(second).toEqual(successResult(cannedResult));
    // Only one daemon is spawned even under parallel first calls.
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('/workspace/project', {
      spawnIfMissing: true,
      cliBinPath: '/workspace/sheriff-cli.js',
    });
  });

  it('returns a clear tool error when the daemon is unavailable', async () => {
    connect.mockResolvedValue(undefined);

    const result = await handleToolCall('verify', {}, options);

    expect(connect).toHaveBeenCalledWith('/workspace/project', {
      spawnIfMissing: true,
      cliBinPath: '/workspace/sheriff-cli.js',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Sheriff daemon unavailable: could not connect or spawn a daemon for /workspace/project.',
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps the connection and returns a tool error on an application error', async () => {
    request.mockRejectedValue(new Error('invalid sheriff config'));

    const result = await handleToolCall('getConfig', {}, options);

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Sheriff daemon request failed: invalid sheriff config',
        },
      ],
      isError: true,
    });
    // The socket is healthy, so the shared connection survives.
    expect(close).not.toHaveBeenCalled();
  });

  it('reuses the same connection after an application error', async () => {
    request.mockRejectedValueOnce(new Error('invalid sheriff config'));

    const failure = await handleToolCall('getConfig', {}, options);
    expect(failure.isError).toBe(true);

    const recovery = await handleToolCall('getConfig', {}, options);
    expect(recovery).toEqual(successResult(cannedResult));
    // No reconnect: the application error never invalidated the connection.
    expect(connect).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('fails only the originating call when a concurrent call errors', async () => {
    request.mockImplementation((method) =>
      method === 'getConfig'
        ? Promise.reject(new Error('invalid sheriff config'))
        : Promise.resolve(cannedResult),
    );

    const [failed, succeeded] = await Promise.all([
      handleToolCall('getConfig', {}, options),
      handleToolCall('verify', {}, options),
    ]);

    expect(failed.isError).toBe(true);
    // The concurrent call completes on the still-open shared connection.
    expect(succeeded).toEqual(successResult(cannedResult));
    expect(close).not.toHaveBeenCalled();
  });

  it('drops the connection when the transport fails', async () => {
    request.mockRejectedValueOnce(
      new DaemonTransportError('daemon connection closed'),
    );

    const result = await handleToolCall('getConfig', {}, options);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('daemon connection closed');
    // A dead socket invalidates the shared connection.
    expect(close).toHaveBeenCalledOnce();

    const recovery = await handleToolCall('getConfig', {}, options);
    expect(recovery).toEqual(successResult(cannedResult));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('rejects fast and reconnects after the connection died while idle', async () => {
    // An idle death emits its single 'error'/'close' with nothing pending,
    // so the bridge still holds the client; the next request must not hang.
    request.mockRejectedValueOnce(
      new DaemonTransportError('daemon connection closed'),
    );

    const result = await handleToolCall('getConfig', {}, options);
    expect(result.isError).toBe(true);
    expect(close).toHaveBeenCalledOnce();

    const recovery = await handleToolCall('getConfig', {}, options);
    expect(recovery).toEqual(successResult(cannedResult));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('drops a wedged daemon after three consecutive timeouts', async () => {
    request.mockRejectedValue(
      new DaemonRequestTimeoutError(
        "daemon request 'getConfig' timed out after 60000ms",
      ),
    );

    const first = await handleToolCall('getConfig', {}, options);
    const second = await handleToolCall('getConfig', {}, options);
    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    // A single timeout must stay non-fatal, otherwise concurrent calls break.
    expect(close).not.toHaveBeenCalled();

    const third = await handleToolCall('getConfig', {}, options);
    expect(third.isError).toBe(true);
    // Three in a row means the daemon is wedged: drop it.
    expect(close).toHaveBeenCalledOnce();

    request.mockResolvedValue(cannedResult);
    const recovery = await handleToolCall('getConfig', {}, options);
    expect(recovery).toEqual(successResult(cannedResult));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('resets the timeout counter on a successful call', async () => {
    const timeout = new DaemonRequestTimeoutError(
      "daemon request 'getConfig' timed out after 60000ms",
    );
    request.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);

    await handleToolCall('getConfig', {}, options);
    await handleToolCall('getConfig', {}, options);
    // A success in between proves the daemon still answers.
    await handleToolCall('getConfig', {}, options);

    request.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);
    await handleToolCall('getConfig', {}, options);
    await handleToolCall('getConfig', {}, options);

    // Four timeouts total, but never three in a row.
    expect(close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('ignores application errors that merely mention a timeout', async () => {
    // Only the typed timeout counts. An ordinary error response whose text
    // happens to say "timed out" arrives over a healthy socket and must
    // never contribute to tearing the shared connection down.
    request.mockRejectedValue(
      new Error('rule check timed out for src/main.ts'),
    );

    await handleToolCall('getConfig', {}, options);
    await handleToolCall('getConfig', {}, options);
    await handleToolCall('getConfig', {}, options);
    await handleToolCall('getConfig', {}, options);

    expect(close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('reuses one connection for equivalent root paths', async () => {
    await handleToolCall('getConfig', {}, options);
    await handleToolCall(
      'getConfig',
      {},
      { ...options, rootDir: '/workspace/project/' },
    );

    // '/foo' and '/foo/' address the same daemon.
    expect(connect).toHaveBeenCalledOnce();
  });

  it('gives concurrently connecting roots their own client', async () => {
    const otherOptions: ToolCallOptions = {
      rootDir: '/workspace/other',
      cliBinPath: '/workspace/sheriff-cli.js',
    };
    const firstClient = { request: vi.fn().mockResolvedValue('first'), close };
    const secondClient = {
      request: vi.fn().mockResolvedValue('second'),
      close,
    };
    // Both connects stay in flight simultaneously, so a root-agnostic
    // pending promise would hand root B the client of root A.
    connect.mockImplementation((rootDir) =>
      Promise.resolve(
        (rootDir === options.rootDir
          ? firstClient
          : secondClient) as unknown as DaemonClient,
      ),
    );

    const [first, second] = await Promise.all([
      handleToolCall('getConfig', {}, options),
      handleToolCall('getConfig', {}, otherOptions),
    ]);

    expect(first).toEqual(successResult('first'));
    expect(second).toEqual(successResult('second'));
    expect(firstClient.request).toHaveBeenCalledOnce();
    expect(secondClient.request).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

function successResult(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) ?? 'null' }],
  };
}
