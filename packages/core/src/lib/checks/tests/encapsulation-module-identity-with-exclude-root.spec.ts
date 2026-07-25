import { describe, expect, it } from 'vitest';
import {
  anyTag,
  violatesEncapsulationRule,
} from '@lambda-solutions/sheriff-core';
import getFs from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { testInit } from '../../test/test-init';
import { sheriffConfig } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';

/**
 * Interaction of `moduleIdentity` with `excludeRoot`, left untested when
 * `moduleIdentity` landed.
 *
 * `src/orphan` carries a barrel file but is covered by no `modules` pattern,
 * so it is exactly the directory whose module identity the two modes disagree
 * about:
 *
 * - `'auto'`: the barrel makes `src/orphan` its own (barrel) module, so
 *   `../orphan/secret` is a deep import past that barrel — a violation.
 * - `'config'`: the barrel creates no module, so `secret.ts` belongs to the
 *   nearest enclosing module, which is the ROOT module. `moduleIdentity:
 *   'config'` requires `enableBarrelLess: true`, and a barrel-less root module
 *   exposes every file that does not match the `encapsulationPattern` — so
 *   there are effectively no encapsulation restrictions on those files at all,
 *   and `excludeRoot` has nothing left to relax. That is why the outcome is
 *   identical for both `excludeRoot` values.
 */
describe('moduleIdentity and excludeRoot', () => {
  const createProjectFor = (
    moduleIdentity: 'auto' | 'config',
    excludeRoot: boolean,
  ) =>
    testInit('src/main.ts', {
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/configured': 'configured' },
        depRules: { '*': anyTag },
        enableBarrelLess: true,
        moduleIdentity,
        excludeRoot,
      }),
      src: {
        'main.ts': ['./configured/importer'],
        configured: { 'importer.ts': ['../orphan/secret'] },
        orphan: {
          'index.ts': ['./secret'],
          'secret.ts': '',
        },
      },
    });

  for (const excludeRoot of [false, true]) {
    it(`should report a deep import into a barrel directory under 'auto' with excludeRoot: ${excludeRoot}`, () => {
      const projectInfo = createProjectFor('auto', excludeRoot);

      // the stray barrel turns `src/orphan` into a module of its own
      expect(projectInfo.modules.map((module) => module.path)).toContain(
        '/project/src/orphan',
      );
      expect(violatesEncapsulation('/project/src/configured/importer.ts')).toBe(
        "'../orphan/secret' is a deep import from a barrel module. Use the module's barrel file (index.ts) instead.",
      );
    });

    it(`should not report the same import under 'config' with excludeRoot: ${excludeRoot}`, () => {
      const projectInfo = createProjectFor('config', excludeRoot);

      // no `modules` pattern covers `src/orphan`, so it is no module at all
      expect(projectInfo.modules.map((module) => module.path)).not.toContain(
        '/project/src/orphan',
      );
      expect(violatesEncapsulation('/project/src/configured/importer.ts')).toBe(
        '',
      );
    });
  }

  it("should not let excludeRoot change the outcome under 'config'", () => {
    // `excludeRoot` only relaxes access to the root module - under 'config'
    // the barrel-less root module already exposes `secret.ts` to everyone, so
    // both settings produce the very same (empty) result.
    createProjectFor('config', false);
    const withRoot = violatesEncapsulation(
      '/project/src/configured/importer.ts',
    );

    createProjectFor('config', true);
    const withoutRoot = violatesEncapsulation(
      '/project/src/configured/importer.ts',
    );

    expect(withRoot).toBe(withoutRoot);
    expect(withRoot).toBe('');
  });

  it("should let excludeRoot change nothing under 'auto' either", () => {
    // the counterpart: under 'auto' the import is blocked by the barrel of
    // `src/orphan`, not by the root module, so `excludeRoot` cannot relax it.
    createProjectFor('auto', false);
    const withRoot = violatesEncapsulation(
      '/project/src/configured/importer.ts',
    );

    createProjectFor('auto', true);
    const withoutRoot = violatesEncapsulation(
      '/project/src/configured/importer.ts',
    );

    expect(withRoot).toBe(withoutRoot);
    expect(withRoot).not.toBe('');
  });
});

function violatesEncapsulation(filename: string): string {
  return violatesEncapsulationRule(
    filename,
    '../orphan/secret',
    true,
    getFs().readFile(toFsPath(filename)),
    false,
  );
}
