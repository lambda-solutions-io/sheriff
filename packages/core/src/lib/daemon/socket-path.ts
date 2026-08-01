import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * One daemon per project root: the socket name is derived from the
 * root directory. Windows requires named pipes instead of socket files.
 * The root is resolved first so a relative and an absolute path to the
 * same project reach the same daemon.
 * Adding the user key changes every legacy socket name once, so
 * already-running old-format daemons can remain orphaned until idle timeout.
 */
export function getDaemonSocketPath(
  rootDir: string,
  userKey = getSocketUserKey(),
): string {
  const rootHash = createHash('sha256')
    .update(userKey)
    .update('\0')
    .update(path.resolve(rootDir))
    .digest('hex')
    .slice(0, 12);

  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sheriff-${rootHash}`
    : path.join(os.tmpdir(), `sheriff-${rootHash}.sock`);
}

function getSocketUserKey(): string {
  if (typeof process.getuid === 'function') {
    return `uid:${process.getuid()}`;
  }

  try {
    return `user:${os.userInfo().username}`;
  } catch {
    return 'user:unknown';
  }
}
