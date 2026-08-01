import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * One daemon per project root: the socket name is derived from the
 * root directory. Windows requires named pipes instead of socket files.
 * The root is resolved first so a relative and an absolute path to the
 * same project reach the same daemon.
 */
export function getDaemonSocketPath(rootDir: string): string {
  const rootHash = createHash('sha256')
    .update(path.resolve(rootDir))
    .digest('hex')
    .slice(0, 12);

  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sheriff-${rootHash}`
    : path.join(os.tmpdir(), `sheriff-${rootHash}.sock`);
}
