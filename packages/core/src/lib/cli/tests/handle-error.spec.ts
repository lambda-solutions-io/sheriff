import { describe, expect, it } from 'vitest';
import { InvalidPathError } from '../../error/user-error';
import { mockCli } from './helpers/mock-cli';
import {
  handleError,
  handleErrorAsync,
  handleErrorOutput,
} from '../internal/handle-error';

describe('with error handling', () => {
  it('should execute the function', () => {
    mockCli();
    let a = 1;

    handleError(() => a++);

    expect(a).toBe(2);
  });

  it('should print out the message of an UserError', () => {
    const { allErrorLogs } = mockCli();
    handleError(() => {
      throw new InvalidPathError('sheriff', 'src/main.ts');
    });

    expect(allErrorLogs()).toBe(
      'invalid path mapping detected: sheriff: src/main.ts. Please verify that the path exists.',
    );
  });

  it('should print out the message of an Error', () => {
    const { allErrorLogs } = mockCli();
    handleError(() => {
      throw new Error('nix geht');
    });

    expect(allErrorLogs()).toBe('nix geht');
  });

  it('should print out the just the error if not of type Error', () => {
    const { allErrorLogs } = mockCli();

    handleError(() => {
      throw 'nix geht';
    });

    expect(allErrorLogs()).toBe('nix geht');
  });

  it('should print out the message with handleErrorOutput', () => {
    const { allErrorLogs } = mockCli();

    handleErrorOutput(new Error('output only'));

    expect(allErrorLogs()).toBe('output only');
  });

  it('should execute async functions', async () => {
    mockCli();
    let a = 1;

    await handleErrorAsync(async () => {
      a++;
    });

    expect(a).toBe(2);
  });

  it('should print async errors', async () => {
    const { allErrorLogs } = mockCli();

    await handleErrorAsync(async () => {
      throw new Error('async nix geht');
    });

    expect(allErrorLogs()).toBe('async nix geht');
  });
});
