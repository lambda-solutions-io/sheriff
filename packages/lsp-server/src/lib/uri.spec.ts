import { describe, expect, it } from 'vitest';
import { isFileUri, uriToFilePath } from './uri';

describe('uriToFilePath', () => {
  it('preserves the authority of UNC file URIs', () => {
    expect(uriToFilePath('file://server/share/folder/a.ts')).toBe(
      '//server/share/folder/a.ts',
    );
  });
});

describe('isFileUri', () => {
  it('accepts file URIs and rejects other schemes and invalid URIs', () => {
    expect(isFileUri('file:///src/app/main.ts')).toBe(true);
    expect(isFileUri('untitled:Untitled-1')).toBe(false);
    expect(isFileUri('git:/project/src/app/main.ts')).toBe(false);
    expect(isFileUri('not a uri')).toBe(false);
  });
});
