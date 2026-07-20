import { describe, expect, it } from 'vitest';
import { uriToFilePath } from './uri';

describe('uriToFilePath', () => {
  it('preserves the authority of UNC file URIs', () => {
    expect(uriToFilePath('file://server/share/folder/a.ts')).toBe(
      '//server/share/folder/a.ts',
    );
  });
});
