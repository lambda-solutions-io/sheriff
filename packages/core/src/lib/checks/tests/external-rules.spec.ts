import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { checkForExternalRuleViolation } from '../check-for-external-rule-violation';
import { toFsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

/**
 * Builds a project with two modules:
 * - `src/domain` tagged `type:domain` — the framework-free core
 * - `src/infra`  tagged `type:infra`  — the adapter, may use anything
 *
 * Both import from the external libraries `@angular/core` and `rxjs`, which
 * live in `node_modules` and are therefore recorded as external libraries.
 */
function createProjectInfo(config: Partial<UserSheriffConfig>) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      modules: {
        'src/domain': ['type:domain'],
        'src/infra': ['type:infra'],
      },
      depRules: { '*': '*' },
      enableBarrelLess: true,
      ...config,
    } as UserSheriffConfig),
    node_modules: {
      '@angular': {
        core: { 'index.ts': [] },
        common: { 'index.ts': [] },
      },
      rxjs: { 'index.ts': [] },
    },
    src: {
      'main.ts': ['./domain/booking.ts', './infra/http.ts'],
      domain: {
        'booking.ts': ['@angular/core'],
      },
      infra: {
        'http.ts': ['@angular/core', 'rxjs'],
      },
    },
  });
}

/**
 * The project must exist before `toFsPath` validates the path.
 */
function violatedExternalsFor(
  config: Partial<UserSheriffConfig>,
  file = 'src/domain/booking.ts',
) {
  const projectInfo = createProjectInfo(config);
  return checkForExternalRuleViolation(
    toFsPath(`/project/${file}`),
    projectInfo,
  ).map((violation) => violation.externalLibrary);
}

describe('externalRules', () => {
  describe('without externalRules there is no behaviour change', () => {
    it('should not report anything when externalRules are absent', () => {
      // The control: `@angular/core` in a `type:domain` module runs green
      // today. This is exactly the gap the feature closes.
      expect(violatedExternalsFor({})).toEqual([]);
    });

    it('should not report anything for an empty externalRules object', () => {
      expect(violatedExternalsFor({ externalRules: {} })).toEqual([]);
    });

    it('should leave tags without an entry unrestricted', () => {
      // `type:domain` has no entry - it stays unrestricted, even though
      // another tag is configured restrictively.
      expect(violatedExternalsFor({ externalRules: { 'type:api': [] } })).toEqual(
        [],
      );
    });
  });

  describe('an empty array forbids every external import', () => {
    it('should report an external import for a tag configured with []', () => {
      expect(
        violatedExternalsFor({ externalRules: { 'type:domain': [] } }),
      ).toEqual(['@angular/core']);
    });

    it('should report every violating library of a file', () => {
      expect(
        violatedExternalsFor({ externalRules: { 'type:infra': [] } }, 'src/infra/http.ts'),
      ).toEqual(['@angular/core', 'rxjs']);
    });
  });

  describe('allow-listing', () => {
    it('should allow an exactly matching package', () => {
      expect(
        violatedExternalsFor({
          externalRules: { 'type:domain': ['@angular/core'] },
        }),
      ).toEqual([]);
    });

    it('should allow a package matched by a wildcard', () => {
      expect(
        violatedExternalsFor({
          externalRules: { 'type:domain': ['@angular/*'] },
        }),
      ).toEqual([]);
    });

    it('should report a package which is not on the allow-list', () => {
      expect(
        violatedExternalsFor(
          { externalRules: { 'type:infra': ['@angular/*'] } },
          'src/infra/http.ts',
        ),
      ).toEqual(['rxjs']);
    });

    it('should allow every listed package', () => {
      expect(
        violatedExternalsFor(
          { externalRules: { 'type:infra': ['@angular/*', 'rxjs'] } },
          'src/infra/http.ts',
        ),
      ).toEqual([]);
    });
  });

  describe('matcher function', () => {
    it('should allow an import when the matcher returns true', () => {
      expect(
        violatedExternalsFor({
          externalRules: { 'type:domain': () => true },
        }),
      ).toEqual([]);
    });

    it('should report an import when the matcher returns false', () => {
      expect(
        violatedExternalsFor({
          externalRules: { 'type:domain': () => false },
        }),
      ).toEqual(['@angular/core']);
    });

    it('should receive the external library and the importing tag', () => {
      expect(
        violatedExternalsFor({
          externalRules: {
            'type:domain': ({ externalLibrary, from }) =>
              externalLibrary === '@angular/core' && from === 'type:domain',
          },
        }),
      ).toEqual([]);
    });
  });

  describe('wildcard keys', () => {
    it('should apply a rule whose key matches the tag by wildcard', () => {
      expect(
        violatedExternalsFor({ externalRules: { 'type:*': [] } }),
      ).toEqual(['@angular/core']);
    });
  });

  describe('multiple tags are AND-combined', () => {
    it('should report the import if any tag of the module forbids it', () => {
      // consistent with the fromTags semantics of dependency rules:
      // every tag must allow the import, one veto is enough.
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: { 'src/domain': ['type:domain', 'scope:core'] },
          depRules: { '*': '*' },
          externalRules: {
            'type:domain': ['@angular/core'], // allows it
            'scope:core': [], // vetoes it
          },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        node_modules: { '@angular': { core: { 'index.ts': [] } } },
        src: {
          'main.ts': ['./domain/booking.ts'],
          domain: { 'booking.ts': ['@angular/core'] },
        },
      });

      expect(
        checkForExternalRuleViolation(
          toFsPath('/project/src/domain/booking.ts'),
          projectInfo,
        ).map((violation) => violation.externalLibrary),
      ).toEqual(['@angular/core']);
    });
  });

  describe('violation shape', () => {
    it('should report the module, the file and the vetoing tag', () => {
      const projectInfo = createProjectInfo({
        externalRules: { 'type:domain': [] },
      });

      const violations = checkForExternalRuleViolation(
        toFsPath('/project/src/domain/booking.ts'),
        projectInfo,
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        externalLibrary: '@angular/core',
        fromModulePath: '/project/src/domain',
        fromFilePath: '/project/src/domain/booking.ts',
        fromTag: 'type:domain',
      });
    });
  });
});
