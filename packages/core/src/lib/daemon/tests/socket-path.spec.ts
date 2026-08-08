import { describe, expect, it } from 'vitest';
import { getDaemonSocketPath } from '../socket-path';

describe('daemon socket path', () => {
  it('should be deterministic per root dir', () => {
    expect(getDaemonSocketPath('/some/project')).toBe(
      getDaemonSocketPath('/some/project'),
    );
  });

  it('should differ between root dirs', () => {
    expect(getDaemonSocketPath('/project-a')).not.toBe(
      getDaemonSocketPath('/project-b'),
    );
  });

  it('should resolve a relative root dir to the same socket as its absolute path', () => {
    expect(getDaemonSocketPath('.')).toBe(getDaemonSocketPath(process.cwd()));
  });

  it('should differ between users for the same root dir', () => {
    expect(getDaemonSocketPath('/some/project', 'uid:1')).not.toBe(
      getDaemonSocketPath('/some/project', 'uid:2'),
    );
  });

  it('should differ between core versions for the same root dir', () => {
    // Version-keyed sockets let two core versions serve the same root at
    // once instead of refusing each other's daemon over the handshake.
    expect(getDaemonSocketPath('/some/project', 'uid:1', '1.0.0')).not.toBe(
      getDaemonSocketPath('/some/project', 'uid:1', '1.1.0'),
    );
  });

  it('should be deterministic per core version', () => {
    expect(getDaemonSocketPath('/some/project', 'uid:1', '1.0.0')).toBe(
      getDaemonSocketPath('/some/project', 'uid:1', '1.0.0'),
    );
  });

  it('should use a named pipe on windows and a socket file elsewhere', () => {
    const socketPath = getDaemonSocketPath('/some/project');
    if (process.platform === 'win32') {
      expect(socketPath).toMatch(/^\\\\\.\\pipe\\sheriff-/);
    } else {
      expect(socketPath).toMatch(/sheriff-[0-9a-f]{12}\.sock$/);
    }
  });
});
