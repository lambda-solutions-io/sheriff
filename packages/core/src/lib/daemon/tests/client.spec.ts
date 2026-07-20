import { EventEmitter } from 'events';
import type * as net from 'net';
import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../client';

class FakeSocket extends EventEmitter {
  setEncoding = vi.fn();
  write = vi.fn();
  destroy = vi.fn(() => this.emit('close'));
}

describe('daemon client', () => {
  it('rejects requests immediately after the connection closes', async () => {
    const socket = new FakeSocket();
    const client = new DaemonClient(socket as unknown as net.Socket);

    expect(client.isConnected).toBe(true);
    client.close();

    expect(client.isConnected).toBe(false);
    await expect(client.request('lintFile')).rejects.toThrow(
      'daemon connection closed',
    );
    expect(socket.write).not.toHaveBeenCalled();
  });

  it('marks the connection dead before rejecting pending requests', async () => {
    const socket = new FakeSocket();
    const client = new DaemonClient(socket as unknown as net.Socket);
    const request = client.request('lintFile');

    socket.emit('error', new Error('socket failed'));

    await expect(request).rejects.toThrow('socket failed');
    expect(client.isConnected).toBe(false);
  });
});
