export type JsonRpcMessage = Record<string, unknown>;

const headerSeparator = Buffer.from('\r\n\r\n');
const contentLengthMarker = 'content-length:';

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
      const { contentLength, valid } = parseHeaders(header);
      const bodyStart = headerEnd + headerSeparator.length;
      if (!valid || contentLength === undefined) {
        if (contentLength !== undefined) {
          const malformedFrameEnd = bodyStart + contentLength;
          if (this.buffer.length < malformedFrameEnd) {
            return messages;
          }
          this.buffer = this.buffer.subarray(malformedFrameEnd);
        } else if (!this.resynchronize(bodyStart)) {
          return messages;
        }
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

  private resynchronize(searchStart: number): boolean {
    const ascii = this.buffer.toString('ascii').toLowerCase();
    const nextHeader = ascii.indexOf(contentLengthMarker, searchStart);
    if (nextHeader !== -1) {
      this.buffer = this.buffer.subarray(nextHeader);
      return true;
    }

    let retainedLength = Math.min(
      contentLengthMarker.length - 1,
      this.buffer.length,
    );
    while (
      retainedLength > 0 &&
      !contentLengthMarker.startsWith(ascii.slice(-retainedLength))
    ) {
      retainedLength--;
    }
    this.buffer = this.buffer.subarray(this.buffer.length - retainedLength);
    return false;
  }
}

export function encodeJsonRpcMessage(message: JsonRpcMessage): Buffer {
  const body = JSON.stringify(message);
  return Buffer.from(
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`,
    'utf8',
  );
}

function parseHeaders(header: string): {
  contentLength: number | undefined;
  valid: boolean;
} {
  let contentLength: number | undefined;
  let valid = header.length > 0;

  for (const line of header.split('\r\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      valid = false;
      continue;
    }

    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) {
      valid = false;
      continue;
    }
    if (name === 'content-length') {
      const rawValue = line.slice(separatorIndex + 1).trim();
      const value = Number(rawValue);
      if (/^\d+$/.test(rawValue) && Number.isSafeInteger(value)) {
        if (contentLength !== undefined) {
          valid = false;
        }
        contentLength = value;
      } else {
        valid = false;
      }
    }
  }

  return { contentLength, valid: valid && contentLength !== undefined };
}
