import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { version as packageVersion } from '../../../package.json';

/**
 * One daemon per project root and core version: the socket name is derived
 * from the root directory. Windows requires named pipes instead of socket
 * files. The root is resolved first so a relative and an absolute path to
 * the same project reach the same daemon.
 * Adding the user key changes every legacy socket name once, so
 * already-running old-format daemons can remain orphaned until idle timeout.
 * The core version is part of the name for the same reason it is checked in
 * the handshake: daemon responses are tied to the analysing core's
 * semantics. Keying by version lets versions coexist instead of refusing
 * each other's socket, and the previous version's daemon is orphaned until
 * idle timeout exactly like the legacy sockets above.
 */
export function getDaemonSocketPath(
  rootDir: string,
  userKey = getSocketUserKey(),
  coreVersion = packageVersion,
): string {
  const rootHash = createHash('sha256')
    .update(userKey)
    .update('\0')
    .update(path.resolve(rootDir))
    .update('\0')
    .update(coreVersion)
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
