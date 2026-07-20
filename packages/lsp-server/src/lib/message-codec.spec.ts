import { describe, expect, it } from 'vitest';
import { JsonRpcMessageReader, encodeJsonRpcMessage } from './message-codec';

describe('message codec', () => {
  it('waits for a complete message across partial chunks', () => {
    const reader = new JsonRpcMessageReader();
    const encoded = encodeJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(reader.push(encoded.subarray(0, 12))).toEqual([]);
    expect(reader.push(encoded.subarray(12, 31))).toEqual([]);
    expect(reader.push(encoded.subarray(31))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      },
    ]);
  });

  it('reads multiple messages from one chunk', () => {
    const reader = new JsonRpcMessageReader();
    const first = {
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    };
    const second = {
      jsonrpc: '2.0',
      id: 2,
      method: 'shutdown',
    };

    expect(
      reader.push(
        Buffer.concat([
          encodeJsonRpcMessage(first),
          encodeJsonRpcMessage(second),
        ]),
      ),
    ).toEqual([first, second]);
  });

  it('skips a malformed JSON frame and keeps decoding later frames', () => {
    const reader = new JsonRpcMessageReader();
    const broken = Buffer.from('Content-Length: 9\r\n\r\n{"id": 1,', 'utf8');
    const valid = { jsonrpc: '2.0', id: 2, method: 'shutdown' };

    expect(
      reader.push(Buffer.concat([broken, encodeJsonRpcMessage(valid)])),
    ).toEqual([valid]);
  });

  it('skips a header block without Content-Length instead of wedging', () => {
    const reader = new JsonRpcMessageReader();
    const headerless = Buffer.from('X-Custom: 1\r\n\r\n', 'utf8');
    const valid = { jsonrpc: '2.0', method: 'initialized', params: {} };

    expect(
      reader.push(Buffer.concat([headerless, encodeJsonRpcMessage(valid)])),
    ).toEqual([valid]);
  });

  it('skips the body of a frame with malformed headers', () => {
    const reader = new JsonRpcMessageReader();
    const malformed = Buffer.from(
      'Content-Length: 4\r\nBroken-Header\r\n\r\njunk',
      'utf8',
    );
    const valid = { jsonrpc: '2.0', id: 3, method: 'shutdown' };

    expect(reader.push(malformed.subarray(0, malformed.length - 2))).toEqual(
      [],
    );
    expect(
      reader.push(
        Buffer.concat([
          malformed.subarray(malformed.length - 2),
          encodeJsonRpcMessage(valid),
        ]),
      ),
    ).toEqual([valid]);
  });

  it('scans past an unknown malformed body to the next valid frame', () => {
    const reader = new JsonRpcMessageReader();
    const malformed = Buffer.from(
      'Broken-Header\r\n\r\nunknown body bytes',
      'utf8',
    );
    const valid = { jsonrpc: '2.0', method: 'initialized', params: {} };

    expect(
      reader.push(Buffer.concat([malformed, encodeJsonRpcMessage(valid)])),
    ).toEqual([valid]);
  });

  it('frames multibyte UTF-8 payloads by byte length', () => {
    const reader = new JsonRpcMessageReader();
    const message = {
      jsonrpc: '2.0',
      method: 'x',
      params: { text: '日本語🙂' },
    };
    const encoded = encodeJsonRpcMessage(message);

    expect(reader.push(encoded.subarray(0, encoded.length - 1))).toEqual([]);
    expect(reader.push(encoded.subarray(encoded.length - 1))).toEqual([
      message,
    ]);
  });
});
