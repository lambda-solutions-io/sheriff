import { describe, expect, it } from 'vitest';
import { isInsideRoot } from '../is-inside-root';

describe('isInsideRoot', () => {
  it('should accept the root itself', () => {
    expect(isInsideRoot('/repo/src', '/repo/src')).toBe(true);
  });

  it('should accept a file inside the root', () => {
    expect(isInsideRoot('/repo/src/app/main.ts', '/repo/src')).toBe(true);
  });

  it('should reject a sibling sharing the root as a prefix', () => {
    expect(isInsideRoot('/repo/src2/main.ts', '/repo/src')).toBe(false);
  });

  it('should reject a path outside the root', () => {
    expect(isInsideRoot('/other/main.ts', '/repo/src')).toBe(false);
  });

  it('should ignore a trailing separator on the root', () => {
    expect(isInsideRoot('/repo/src/main.ts', '/repo/src/')).toBe(true);
    expect(isInsideRoot('/repo/src2/main.ts', '/repo/src/')).toBe(false);
  });

  it('should treat backslashes as separators', () => {
    expect(isInsideRoot('C:\\repo\\src\\main.ts', 'C:\\repo\\src')).toBe(true);
    expect(isInsideRoot('C:\\repo\\src2\\main.ts', 'C:\\repo\\src')).toBe(
      false,
    );
  });

  it('should accept a path mixing separators', () => {
    expect(isInsideRoot('C:\\repo\\src/main.ts', 'C:\\repo\\src')).toBe(true);
  });
});
