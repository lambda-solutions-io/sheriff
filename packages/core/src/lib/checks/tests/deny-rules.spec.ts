import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { checkForDependencyRuleViolation } from '../check-for-dependency-rule-violation';
import { toFsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

/**
 * Builds a project where `src/domain` (tagged `domain:booking` + `type:domain`)
 * imports from `src/shared` (tagged `shared`).
 *
 * `enableBarrelLess` is required: without it every file lands in the implicit
 * root module and same-module imports are never checked at all.
 */
function createProjectInfo(config: Partial<UserSheriffConfig>) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      modules: {
        'src/domain': ['domain:booking', 'type:domain'],
        'src/shared': ['shared'],
      },
      enableBarrelLess: true,
      ...config,
    } as UserSheriffConfig),
    src: {
      'main.ts': ['./domain/booking.ts'],
      domain: {
        'booking.ts': ['../shared/util.ts'],
      },
      shared: {
        'util.ts': [],
      },
    },
  });
}

/**
 * The project must be created before `toFsPath` runs, because `toFsPath`
 * validates against the (virtual) filesystem.
 */
function violationsFor(config: Partial<UserSheriffConfig>) {
  const projectInfo = createProjectInfo(config);
  return checkForDependencyRuleViolation(
    toFsPath('/project/src/domain/booking.ts'),
    projectInfo,
  );
}

function violatedImportsFor(config: Partial<UserSheriffConfig>) {
  return violationsFor(config).map((violation) => violation.rawImport);
}

/**
 * The permissive baseline from the task list: `'*'` grants clearance to
 * `shared` via any tag, even though `type:domain` only permits `type:domain`.
 * `root` is needed so that `src/main.ts`'s own module has a rule.
 */
const permissiveDepRules = {
  '*': 'shared',
  'type:domain': 'type:domain',
  'domain:*': 'shared',
  root: '*',
};

describe('denyRules', () => {
  describe('deny beats allow', () => {
    it('should allow the import when no denyRules are configured', () => {
      // The status quo and the mutation probe's control: '*' grants clearance
      // to `shared`, so there is NO violation. If this ever fails, the tests
      // below prove nothing.
      expect(violatedImportsFor({ depRules: permissiveDepRules })).toEqual([]);
    });

    it('should block the import although a permissive `*` rule allows it', () => {
      // The real-world case: a module tagged ['domain:booking', 'type:domain']
      // must not reach `shared`, even though '*' and 'domain:*' allow it.
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: {
            'type:domain': ({ to }) => to !== 'type:domain',
          },
        }),
      ).toEqual(['../shared/util.ts']);
    });

    it('should report the denying tag as the violation cause', () => {
      const violations = violationsFor({
        depRules: permissiveDepRules,
        denyRules: {
          'type:domain': ({ to }) => to !== 'type:domain',
        },
      });

      expect(violations).toHaveLength(1);
      // the violation must be attributable to the tag which denied it,
      // not to an arbitrary tag which merely lacked clearance
      expect(violations[0].fromTag).toBe('type:domain');
      expect(violations[0].toTags).toEqual(['shared']);
    });

    it('should deny regardless of key order in depRules', () => {
      // same rules, reversed insertion order - deny must still win
      expect(
        violatedImportsFor({
          depRules: {
            root: '*',
            'domain:*': 'shared',
            'type:domain': 'type:domain',
            '*': 'shared',
          },
          denyRules: {
            'type:domain': ({ to }) => to !== 'type:domain',
          },
        }),
      ).toEqual(['../shared/util.ts']);
    });

    it('should deny with a plain string denyRule', () => {
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: { 'type:domain': 'shared' },
        }),
      ).toEqual(['../shared/util.ts']);
    });

    it('should deny when the denyRule key is a wildcard', () => {
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: { 'domain:*': 'shared' },
        }),
      ).toEqual(['../shared/util.ts']);
    });
  });

  describe('denyRules never widen', () => {
    it('should keep the depRules result when no denyRule matches', () => {
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: { 'type:infra': 'shared' },
        }),
      ).toEqual([]);
    });

    it('should behave bit-identically with an empty denyRules object', () => {
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: {},
        }),
      ).toEqual([]);
    });

    it('should not turn a depRules violation into an allowed import', () => {
      // denyRules must never grant clearance. Here depRules forbid `shared`
      // for every tag of the module, and denyRules do not match at all.
      const restrictiveDepRules = {
        root: '*',
        'domain:*': 'type:domain',
        'type:domain': 'type:domain',
      };

      expect(
        violatedImportsFor({
          depRules: restrictiveDepRules,
          denyRules: { 'type:infra': 'shared' },
        }),
      ).toEqual(['../shared/util.ts']);
    });
  });

  describe('matcher context receives file paths (#47)', () => {
    it('should pass the imported file path as toFilePath to denyRules', () => {
      // `src/domain/booking.ts` imports `src/shared/util.ts`. A file-sensitive
      // denyRule must see the imported FILE, not its module directory -
      // otherwise `endsWith('/util.ts')` never matches and the forbidden
      // import passes silently.
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: {
            'type:domain': ({ toFilePath }) => toFilePath.endsWith('/util.ts'),
          },
        }),
      ).toEqual(['../shared/util.ts']);
    });

    it('should keep toModulePath as the module directory alongside toFilePath', () => {
      // the matcher cannot close over test-scope variables (the config is
      // serialized and eval'd), so both exact paths are asserted via a deny
      // rule which only fires when file AND module path are correct
      expect(
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: {
            'type:domain': ({ toFilePath, toModulePath }) =>
              toFilePath === '/project/src/shared/util.ts' &&
              toModulePath === '/project/src/shared',
          },
        }),
      ).toEqual(['../shared/util.ts']);
    });

    it('should pass the imported file path as toFilePath to depRules', () => {
      // depRules share the same context object, so they must see the file too.
      // Only `type:domain` decides here; the other tags have clearance.
      expect(
        violatedImportsFor({
          depRules: {
            root: '*',
            'domain:*': 'shared',
            'type:domain': ({ toFilePath }) =>
              !toFilePath.endsWith('/util.ts'),
          },
        }),
      ).toEqual(['../shared/util.ts']);
    });
  });

  describe('no NoDependencyRuleForTagError for denyRules', () => {
    it('should not throw when a tag has no denyRule entry', () => {
      // 'domain:booking' has no denyRules entry at all - that is normal,
      // unlike depRules, where a missing tag raises NoDependencyRuleForTagError
      expect(() =>
        violatedImportsFor({
          depRules: permissiveDepRules,
          denyRules: { 'type:domain': 'nothing-matching' },
        }),
      ).not.toThrow();
    });
  });
});
