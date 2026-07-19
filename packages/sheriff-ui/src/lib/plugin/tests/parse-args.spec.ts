import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, parseUiArgs } from '../parse-args';

describe('parseUiArgs', () => {
  it('returns defaults for no args', () => {
    expect(parseUiArgs([])).toEqual({
      port: DEFAULT_PORT,
      open: true,
      json: false,
    });
  });

  it('parses all flags', () => {
    expect(
      parseUiArgs([
        '--port',
        '8080',
        '--no-open',
        '--json',
        '--entry-file',
        'src/main.ts',
      ]),
    ).toEqual({
      port: 8080,
      open: false,
      json: true,
      entryFile: 'src/main.ts',
    });
  });

  it('applies plugin option defaults', () => {
    expect(parseUiArgs([], { port: 9000, open: false })).toMatchObject({
      port: 9000,
      open: false,
    });
  });

  it('rejects invalid ports', () => {
    expect(() => parseUiArgs(['--port', 'abc'])).toThrow('invalid --port');
    expect(() => parseUiArgs(['--port', '70000'])).toThrow('invalid --port');
    expect(() => parseUiArgs(['--port'])).toThrow('invalid --port');
  });

  it('rejects unknown options', () => {
    expect(() => parseUiArgs(['--wat'])).toThrow('unknown option: --wat');
  });

  it('requires a value for --entry-file', () => {
    expect(() => parseUiArgs(['--entry-file'])).toThrow(
      '--entry-file requires a value',
    );
  });
});
