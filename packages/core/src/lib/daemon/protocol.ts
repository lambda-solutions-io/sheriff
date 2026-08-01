/**
 * Newline-delimited JSON-RPC over a local socket. Each line is one
 * complete request or response object; no framing library needed.
 */

export type DaemonRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type DaemonResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};

export type HandshakeResult = {
  coreVersion: string;
  rootDir: string;
  pid: number;
  compatible?: boolean;
};

export function encodeMessage(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Stateful line splitter: feed socket chunks, receive complete
 * JSON lines. Keeps a partial trailing line buffered.
 */
export function createLineDecoder(onLine: (line: string) => void) {
  let buffered = '';

  return (chunk: string) => {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      if (line.trim()) {
        onLine(line);
      }
      newlineIndex = buffered.indexOf('\n');
    }
  };
}
