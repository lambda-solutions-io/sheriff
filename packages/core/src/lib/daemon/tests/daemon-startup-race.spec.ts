import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDaemonStatus } from '../client';
import { DaemonServer, startDaemonServer } from '../server';
import { getDaemonSocketPath } from '../socket-path';

/**
 * Regression tests for the daemon socket hijack (issue #42): a second
 * startup must never unlink a live daemon's socket, and a daemon's
 * shutdown must never unlink a successor daemon's socket.
 * Unix socket files only; Windows named pipes cannot be hijacked this way.
 */
describe.skipIf(process.platform === 'win32')('daemon startup race', () => {
  let rootDir: string;
  const servers: DaemonServer[] = [];

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-daemon-race-'));
  });

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const start = async () => {
    const server = await startDaemonServer({ rootDir, exit: () => void 0 });
    servers.push(server);
    return server;
  };

  it('should refuse to start while another daemon is listening', async () => {
    await start();

    await expect(start()).rejects.toThrow(/already listening|EADDRINUSE/);

    // the first daemon must have kept its socket and stayed reachable
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });

  it('should not unlink a successor daemon socket on shutdown', async () => {
    const firstServer = await start();

    // simulate the hijack: the first daemon loses its socket file and a
    // second daemon claims the now-free path
    fs.unlinkSync(firstServer.socketPath);
    await start();

    // the orphaned first daemon shuts down; the successor must survive
    firstServer.close();
    expect(fs.existsSync(firstServer.socketPath)).toBe(true);
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });

  it('should remove a regular file squatting on the socket path', async () => {
    const socketPath = getDaemonSocketPath(rootDir);
    fs.writeFileSync(socketPath, 'not a socket');

    const server = await start();

    expect(server.socketPath).toBe(socketPath);
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });

  it('should remove an empty directory squatting on the socket path', async () => {
    const socketPath = getDaemonSocketPath(rootDir);
    fs.mkdirSync(socketPath);

    const server = await start();

    expect(server.socketPath).toBe(socketPath);
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });

  it('should report an unprobeable socket instead of claiming a live daemon', async () => {
    // root can probe anything; the EACCES branch is unreachable then
    if (process.getuid?.() === 0) {
      return;
    }
    const socketPath = getDaemonSocketPath(rootDir);
    await createStaleSocket(socketPath);
    fs.chmodSync(socketPath, 0o000);

    await expect(start()).rejects.toThrow(/permission denied.*manually/);

    fs.chmodSync(socketPath, 0o755);
    fs.unlinkSync(socketPath);
  });

  it('should remove a stale socket left behind by a crashed daemon', async () => {
    const socketPath = getDaemonSocketPath(rootDir);
    await createStaleSocket(socketPath);
    expect(fs.existsSync(socketPath)).toBe(true);

    const server = await start();

    expect(server.socketPath).toBe(socketPath);
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });
});

/**
 * Leaves a dead socket file behind by SIGKILLing a listening child;
 * a graceful `server.close()` would unlink the file itself.
 */
function createStaleSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('net').createServer().listen(process.argv[1], () => process.send('ready'));`,
        socketPath,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    child.once('message', () => child.kill('SIGKILL'));
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}
