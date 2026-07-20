export type JsonRpcMessage = Record<string, unknown>;

const headerSeparator = Buffer.from('\r\n\r\n');

export class JsonRpcMessageReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): JsonRpcMessage[] {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, nextChunk]);

    const messages: JsonRpcMessage[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf(headerSeparator);
      if (headerEnd === -1) {
        return messages;
      }

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const contentLength = parseContentLength(header);
      const bodyStart = headerEnd + headerSeparator.length;
      if (contentLength === undefined) {
        // a header block without Content-Length can never be completed;
        // skip it instead of wedging the stream forever.
        this.buffer = this.buffer.subarray(bodyStart);
        continue;
      }
      const messageEnd = bodyStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return messages;
      }

      const body = this.buffer.subarray(bodyStart, messageEnd).toString('utf8');
      // consume the frame before parsing so a malformed body cannot
      // wedge the codec or drop later frames from the same chunk.
      this.buffer = this.buffer.subarray(messageEnd);
      try {
        messages.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // malformed frame: skip it, keep decoding subsequent frames
      }
    }
  }
}

export function encodeJsonRpcMessage(message: JsonRpcMessage): Buffer {
  const body = JSON.stringify(message);
  return Buffer.from(
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`,
    'utf8',
  );
}

function parseContentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name === 'content-length') {
      const value = Number(line.slice(separatorIndex + 1).trim());
      if (Number.isInteger(value) && value >= 0) {
        return value;
      }
    }
  }

  return undefined;
}
