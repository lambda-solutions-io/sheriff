import { describe, expect, it, vi } from 'vitest';
import { createLineDecoder, encodeMessage } from '../protocol';

describe('daemon protocol', () => {
  it('should encode messages as single lines', () => {
    expect(encodeMessage({ id: 1, method: 'verify' })).toBe(
      '{"id":1,"method":"verify"}\n',
    );
  });

  it('should decode complete lines from chunks', () => {
    const onLine = vi.fn();
    const decode = createLineDecoder(onLine);

    decode('{"id":1}\n{"id":2}\n');

    expect(onLine).toHaveBeenNthCalledWith(1, '{"id":1}');
    expect(onLine).toHaveBeenNthCalledWith(2, '{"id":2}');
  });

  it('should buffer partial lines across chunks', () => {
    const onLine = vi.fn();
    const decode = createLineDecoder(onLine);

    decode('{"id":');
    expect(onLine).not.toHaveBeenCalled();

    decode('1}\n');
    expect(onLine).toHaveBeenCalledWith('{"id":1}');
  });

  it('should skip empty lines', () => {
    const onLine = vi.fn();
    const decode = createLineDecoder(onLine);

    decode('\n\n{"id":1}\n\n');

    expect(onLine).toHaveBeenCalledTimes(1);
  });
});
