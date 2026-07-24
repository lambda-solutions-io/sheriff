import { RuleTester } from 'eslint';
import { afterEach, describe, expect, it, vitest } from 'vitest';
import * as sheriffCore from '@lambda-solutions/sheriff-core';
import { parser } from 'typescript-eslint';
import { barrelPolicy } from '../barrel-policy';

const tester = new RuleTester({
  languageOptions: { parser, sourceType: 'module' },
});

describe('barrel-policy', () => {
  const spy = vitest.spyOn(sheriffCore, 'violatesBarrelPolicy');

  afterEach(() => {
    spy.mockReset();
  });

  it('should check the linted file exactly once', () => {
    const code = 'export {a} from "./a"; export {b} from "./b";';
    spy.mockImplementation(() => '');
    tester.run('barrel-policy', barrelPolicy, {
      valid: [{ code }],
      invalid: [],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('<input>', code);
  });

  it('should check a file without imports via the Program node', () => {
    spy.mockImplementation(() => '');
    tester.run('barrel-policy', barrelPolicy, {
      valid: [{ code: 'const a = 1' }],
      invalid: [],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('<input>', 'const a = 1');
  });

  it('should report an empty stray barrel file', () => {
    spy.mockImplementation(() => 'stray barrel');
    tester.run('barrel-policy', barrelPolicy, {
      valid: [],
      invalid: [
        {
          code: '',
          errors: [
            {
              message: 'stray barrel',
            },
          ],
        },
      ],
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('should keep an empty legal file silent', () => {
    spy.mockImplementation(() => '');
    tester.run('barrel-policy', barrelPolicy, {
      valid: [{ code: '' }],
      invalid: [],
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('should directly use the message from the barrel policy check', () => {
    spy.mockImplementation(
      () =>
        'index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
    );
    tester.run('barrel-policy', barrelPolicy, {
      valid: [],
      invalid: [
        {
          code: 'export * from "./customer.component"',
          errors: [
            {
              message:
                'index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
            },
          ],
        },
      ],
    });
  });

  it('should report only once for a barrel with multiple exports', () => {
    spy.mockImplementation(() => 'violation');
    tester.run('barrel-policy', barrelPolicy, {
      valid: [],
      invalid: [
        {
          code: 'export * from "./a"; export * from "./b";',
          errors: [
            {
              message: 'violation',
            },
          ],
        },
      ],
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('should report an internal error only once', () => {
    spy.mockImplementation(() => {
      throw new Error('This is an error');
    });
    tester.run('barrel-policy', barrelPolicy, {
      valid: [],
      invalid: [
        {
          code:
            'import {AppComponent} from "./app.component";' +
            'import {Service} from "somewhere";',
          errors: [
            {
              message: 'Barrel Policy (internal error): This is an error',
            },
          ],
        },
      ],
    });
  });
});
