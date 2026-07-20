import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  runAsWorker: vi.fn(),
}));

vi.mock('@lambda-solutions/sheriff-core', () => ({
  DaemonClient: { connect: mocks.connect },
}));
vi.mock('synckit', () => ({ runAsWorker: mocks.runAsWorker }));

import type { DaemonLintResult } from '../daemon-bridge';
import { createLintFileHandler } from '../lint-file.worker';

const emptyLintResult: DaemonLintResult = {
  dependencyRuleViolations: [],
  encapsulationViolations: [],
  externalRuleViolations: [],
  unresolvableImports: [],
};

describe('lint file worker', () => {
  beforeEach(() => {
    mocks.connect.mockReset();
  });

  it('reuses one daemon connection across sequential lint requests', async () => {
    const client = {
      request: vi.fn().mockResolvedValue(emptyLintResult),
      close: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);
    const lintFile = createLintFileHandler();

    // DaemonClient.connect performs the automatic handshake, so one connect
    // invocation proves both connect and handshake happen only once.
    await lintFile('/project', '/project/first.ts', 'first content');
    await lintFile('/project', '/project/second.ts', 'second content');
    await lintFile('/project', '/project/third.ts', 'third content');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('reconnects once after the retained connection closes', async () => {
    const disconnectedClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(emptyLintResult)
        .mockRejectedValueOnce(new Error('daemon connection closed')),
      close: vi.fn(),
    };
    const replacementClient = {
      request: vi.fn().mockResolvedValue(emptyLintResult),
      close: vi.fn(),
    };
    mocks.connect
      .mockResolvedValueOnce(disconnectedClient)
      .mockResolvedValueOnce(replacementClient);
    const lintFile = createLintFileHandler();

    await lintFile('/project', '/project/first.ts', 'first content');
    await lintFile('/project', '/project/second.ts', 'second content');

    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(disconnectedClient.close).toHaveBeenCalledTimes(1);
    expect(replacementClient.request).toHaveBeenCalledWith('lintFile', {
      filename: '/project/second.ts',
      fileContent: 'second content',
    });
  });

  it('does not reconnect after an application-level daemon error', async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error('lint failed')),
      close: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);
    const lintFile = createLintFileHandler();

    await expect(
      lintFile('/project', '/project/file.ts', 'content'),
    ).rejects.toThrow('lint failed');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('preserves the unreachable error when no daemon accepts a connection', async () => {
    mocks.connect.mockResolvedValue(undefined);
    const lintFile = createLintFileHandler();

    await expect(
      lintFile('/project', '/project/file.ts', 'content'),
    ).rejects.toThrow('sheriff daemon unreachable');
  });

  it('invalidates the cached connection when rootDir changes', async () => {
    const firstClient = {
      request: vi.fn().mockResolvedValue(emptyLintResult),
      close: vi.fn(),
    };
    const secondClient = {
      request: vi.fn().mockResolvedValue(emptyLintResult),
      close: vi.fn(),
    };
    mocks.connect
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const lintFile = createLintFileHandler();

    await lintFile('/project-a', '/project-a/file.ts', 'first content');
    await lintFile('/project-b', '/project-b/file.ts', 'second content');

    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenNthCalledWith(2, '/project-b');
  });
});
