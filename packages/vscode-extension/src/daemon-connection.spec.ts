import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '@lambda-solutions/sheriff-core';
import { SheriffDaemon } from './daemon-connection';

vi.mock('@lambda-solutions/sheriff-core', () => ({
  DaemonClient: { connect: vi.fn() },
}));

const connect = DaemonClient.connect as unknown as ReturnType<typeof vi.fn>;

/** Minimal DaemonClient stand-in with a toggleable `closed` flag. */
function fakeClient(overrides: Partial<{ closed: boolean }> = {}) {
  return {
    closed: overrides.closed ?? false,
    request: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn(),
  };
}

describe('SheriffDaemon connection lifecycle', () => {
  beforeEach(() => {
    connect.mockReset();
  });

  it('shares one connect across concurrent cold-start callers', async () => {
    const client = fakeClient();
    let resolveConnect: (value: unknown) => void = () => undefined;
    connect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );

    const daemon = new SheriffDaemon('/root', '/cli');
    const first = daemon.lintFile('/root/a.ts');
    const second = daemon.lintFile('/root/b.ts');

    resolveConnect(client);
    await Promise.all([first, second]);

    // A single spawn/connect despite two simultaneous requests.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('drops and reconnects when the cached client is closed', async () => {
    const dead = fakeClient({ closed: true });
    const fresh = fakeClient();
    connect.mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);

    const daemon = new SheriffDaemon('/root', '/cli');
    await daemon.lintFile('/root/a.ts');
    // dead is closed -> second call must reconnect rather than reuse it.
    await daemon.lintFile('/root/b.ts');

    expect(connect).toHaveBeenCalledTimes(2);
    expect(fresh.request).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared client on an application error', async () => {
    const client = fakeClient();
    client.request.mockRejectedValueOnce(
      new Error('sheriff.config.ts not found'),
    );
    connect.mockResolvedValue(client);

    const daemon = new SheriffDaemon('/root', '/cli');
    await expect(daemon.lintFile('/root/a.ts')).rejects.toThrow(
      'sheriff.config.ts not found',
    );

    // Healthy socket must not be torn down on an app error.
    expect(client.close).not.toHaveBeenCalled();
    await daemon.lintFile('/root/b.ts');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('drops the client on a transport error', async () => {
    const broken = fakeClient();
    broken.request.mockRejectedValueOnce(
      new Error('daemon connection closed'),
    );
    const fresh = fakeClient();
    connect.mockResolvedValueOnce(broken).mockResolvedValueOnce(fresh);

    const daemon = new SheriffDaemon('/root', '/cli');
    await expect(daemon.lintFile('/root/a.ts')).rejects.toThrow(
      'daemon connection closed',
    );
    expect(broken.close).toHaveBeenCalled();

    await daemon.lintFile('/root/b.ts');
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
