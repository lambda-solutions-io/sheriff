import { describe, expect, test, it } from 'vitest';
import {
  DependencyCheckContext,
  DependencyRulesConfig,
} from '../../config/dependency-rules-config';
import { isDependencyDenied } from '../is-dependency-denied';
import { FsPath } from '../../file-info/fs-path';
import { noDependencies } from '../no-dependencies';
import '../../test/expect.extensions';

type TestParams = [string, boolean][];

const createMockDependencyCheckContext = (
  overrides?: Partial<DependencyCheckContext>,
): DependencyCheckContext =>
  ({
    fromModulePath: '',
    toModulePath: '',
    fromFilePath: '',
    toFilePath: '',
    fromTags: [],
    toTags: [],
    ...overrides,
  }) as DependencyCheckContext;

const dummyContext: DependencyCheckContext = createMockDependencyCheckContext({
  fromModulePath: '/project/moduleFrom' as FsPath,
  toModulePath: '/project/moduleTo' as FsPath,
  fromFilePath: '/project/moduleFrom/some.component.ts' as FsPath,
  toFilePath: '/project/cool.service.ts' as FsPath,
  fromTags: ['domain:customers'],
  toTags: ['domain:holidays'],
});

const createAssertsForConfig = (config: DependencyRulesConfig) => {
  return {
    assertDenied(from: string, to: string | string[]) {
      const toTags = Array.isArray(to) ? to : [to];
      expect(
        isDependencyDenied(
          from,
          config,
          createMockDependencyCheckContext({ toTags }),
        ),
      ).toBe(true);
    },
    assertNotDenied(from: string, to: string | string[]) {
      const toTags = Array.isArray(to) ? to : [to];
      expect(
        isDependencyDenied(
          from,
          config,
          createMockDependencyCheckContext({ toTags }),
        ),
      ).toBe(false);
    },
    assert(from: string, to: string | string[], expected: boolean) {
      const toTags = Array.isArray(to) ? to : [to];
      expect(
        isDependencyDenied(
          from,
          config,
          createMockDependencyCheckContext({ toTags }),
        ),
      ).toBe(expected);
    },
  };
};

describe('denyRules', () => {
  describe('isDependencyDenied', () => {
    it('should not deny anything for an empty config', () => {
      const { assertNotDenied } = createAssertsForConfig({});

      assertNotDenied('type:domain', 'shared');
    });

    it('should not throw if no denyRule exists for a tag', () => {
      // a tag without a deny rule is normal - unlike depRules, this must
      // never raise NoDependencyRuleForTagError
      expect(() =>
        isDependencyDenied('type:unknown', { 'type:domain': 'shared' }, dummyContext),
      ).not.toThrow();
    });

    it('should not deny if the tag has no matching denyRule', () => {
      const { assertNotDenied } = createAssertsForConfig({
        'type:domain': 'shared',
      });

      assertNotDenied('type:feature', 'shared');
    });

    test('single string rule denies a matching target tag', () => {
      const { assertDenied, assertNotDenied } = createAssertsForConfig({
        'type:domain': 'shared',
      });

      assertDenied('type:domain', 'shared');
      assertNotDenied('type:domain', 'type:domain');
    });

    test('multiple string rules deny any matching target tag', () => {
      const { assertDenied, assertNotDenied } = createAssertsForConfig({
        'type:domain': ['shared', 'type:infra'],
      });

      assertDenied('type:domain', 'shared');
      assertDenied('type:domain', 'type:infra');
      assertNotDenied('type:domain', 'type:api');
    });

    it('should deny if any of the toTags matches', () => {
      const { assertDenied } = createAssertsForConfig({
        'type:domain': 'type:infra',
      });

      assertDenied('type:domain', ['shared', 'type:infra']);
    });

    it('should support wildcards in the rule key', () => {
      const { assertDenied, assertNotDenied } = createAssertsForConfig({
        'domain:*': 'type:infra',
      });

      assertDenied('domain:booking', 'type:infra');
      assertNotDenied('type:domain', 'type:infra');
    });

    it('should support wildcards in the rule value', () => {
      const { assertDenied, assertNotDenied } = createAssertsForConfig({
        'type:domain': ['infra:*'],
      });

      assertDenied('type:domain', 'infra:http');
      assertNotDenied('type:domain', 'type:api');
    });

    for (const [to, isDenied] of [
      ['shared', true],
      ['type:infra', true],
      ['type:domain', false],
    ] as TestParams) {
      it(`should support a matcher function and deny ${to}: ${isDenied}`, () => {
        const { assert } = createAssertsForConfig({
          'type:domain': ({ to }) => to !== 'type:domain',
        });

        assert('type:domain', to, isDenied);
      });
    }

    it('should pass from, to and the full context to a matcher function', () => {
      isDependencyDenied(
        'domain:customers',
        {
          'domain:customers': (context) => {
            expect(context).toStrictEqual({
              ...dummyContext,
              from: 'domain:customers',
              to: 'domain:holidays',
            });
            return true;
          },
        },
        dummyContext,
      );
    });

    it('should evaluate every matching key, not only the first', () => {
      // the second key must still be able to deny, even though the first
      // one did not match
      const { assertDenied } = createAssertsForConfig({
        'domain:*': ({ from, to }) => from === to,
        'domain:booking': 'shared',
      });

      assertDenied('domain:booking', 'shared');
    });

    it.each(['type:model', 'shared', 'type:infra'])(
      'should deny every dependency with a `*` value on %s',
      (toTag) => {
        const { assertDenied } = createAssertsForConfig({
          'type:domain': '*',
        });

        assertDenied('type:domain', toTag);
      },
    );

    it('should deny nothing for an empty matcher list, mirroring `noDependencies`', () => {
      // `noDependencies` is an empty matcher array. In deny semantics there is
      // nothing to match, so it must NOT deny - it is an allow-side idiom.
      const { assertNotDenied } = createAssertsForConfig({
        'type:domain': noDependencies,
      });

      assertNotDenied('type:domain', 'shared');
    });

    it('should work with fromTags in a matcher function', () => {
      expect(
        isDependencyDenied(
          'type:domain',
          {
            'type:domain': ({ fromTags, toTags }) =>
              fromTags.includes('type:domain') && !toTags.includes('type:domain'),
          },
          createMockDependencyCheckContext({
            fromTags: ['domain:booking', 'type:domain'],
            toTags: ['shared'],
          }),
        ),
      ).toBe(true);
    });

    it('should not deny when the matcher function returns false', () => {
      const { assertNotDenied } = createAssertsForConfig({
        'type:domain': () => false,
      });

      assertNotDenied('type:domain', 'shared');
    });
  });
});
