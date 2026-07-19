import { DaemonClient } from '@lambda-solutions/sheriff-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDaemonConnection } from './daemon-bridge';
import { handleToolCall, ToolCallOptions } from './tools';

vi.mock('@lambda-solutions/sheriff-core', () => ({
  DaemonClient: {
    connect: vi.fn(),
  },
}));

describe('Sheriff MCP tool dispatch', () => {
  const cannedResult = { valid: true };
  const request = vi.fn<
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

  it('closes the client and returns a tool error when a request fails', async () => {
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
    // A failed request drops the shared connection so the next call reconnects.
    expect(close).toHaveBeenCalledOnce();
  });

  it('reconnects after a failed request dropped the connection', async () => {
    request.mockRejectedValueOnce(new Error('invalid sheriff config'));

    const failure = await handleToolCall('getConfig', {}, options);
    expect(failure.isError).toBe(true);
    expect(close).toHaveBeenCalledOnce();

    const recovery = await handleToolCall('getConfig', {}, options);
    expect(recovery).toEqual(successResult(cannedResult));
    // A second connect happens because the failed connection was dropped.
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

function successResult(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) ?? 'null' }],
  };
}
