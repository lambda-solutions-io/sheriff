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
});
