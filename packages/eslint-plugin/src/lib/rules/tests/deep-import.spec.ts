import { RuleTester } from 'eslint';
import { afterEach, describe, expect, it, vitest } from 'vitest';
import { deepImport } from '../deep-import';
import * as sheriffCore from '@lambda-solutions/sheriff-core';
import * as daemonLintCache from '../../daemon-bridge/daemon-lint-cache';
import { parser } from 'typescript-eslint';

const tester = new RuleTester({
  languageOptions: { parser, sourceType: 'module' },
});

describe('deep-import', () => {
  const spy = vitest.spyOn(sheriffCore, 'violatesEncapsulationRule');
  const daemonSpy = vitest.spyOn(
    daemonLintCache,
    'daemonDeepImportMessage',
  ).mockReturnValue(undefined);

  afterEach(() => {
    spy.mockReset();
    daemonSpy.mockReset();
    daemonSpy.mockReturnValue(undefined);
  });

  it.each([
    {
      code: 'import {AppComponent} from "./app.component"',
      moduleName: './app.component',
    },
    {
      code: 'import * as path from "path"',
      moduleName: 'path',
    },
    {
      code: 'import {inject} from "@angular/core"',
      moduleName: '@angular/core',
    },
  ])('should check for $moduleName in $code', ({ code, moduleName }) => {
    spy.mockImplementation(() => '');
    tester.run('deep-import', deepImport, {
      valid: [{ code }],
      invalid: [],
    });
    expect(spy).toHaveBeenCalledWith('<input>', moduleName, true, code, true);
  });

  it('should not check for deep imports if no import are present', () => {
    tester.run('deep-import', deepImport, {
      valid: [{ code: 'const a = 1' }],
      invalid: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('should use any message from deep import', () => {
    spy.mockImplementation(() => 'nothing works');
    tester.run('deep-import', deepImport, {
      valid: [],
      invalid: [
        {
          code: 'import {AppComponent} from "./app.component"',
          errors: [
            {
              message: 'nothing works',
            },
          ],
        },
      ],
    });
  });

  it('should use the daemon bridge and preserve the legacy message', () => {
    daemonSpy.mockReturnValue(
      "Deep import is not allowed. Use the module's index.ts or path.",
    );
    tester.run('deep-import', deepImport, {
      valid: [],
      invalid: [
        {
          code: 'import {AppComponent} from "./app.component"',
          errors: [
            {
              message:
                "Deep import is not allowed. Use the module's index.ts or path.",
            },
          ],
        },
      ],
    });

    expect(daemonSpy).toHaveBeenCalledWith(
      '<input>',
      './app.component',
      true,
      'import {AppComponent} from "./app.component"',
      expect.any(Object),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('should report an internal error only once', () => {
    spy.mockImplementation(() => {
      throw new Error('This is an error');
    });
    tester.run('deep-import', deepImport, {
      valid: [],
      invalid: [
        {
          code:
            'import {AppComponent} from "./app.component";' +
            'import {Service} from "somewhere";',
          errors: [
            {
              message: 'Deep Import (internal error): This is an error',
            },
          ],
        },
      ],
    });
  });
});
