import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { checkForDependencyRuleViolation } from '../check-for-dependency-rule-violation';
import { toFsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

/**
 * End-to-end guard for modules defined via `**` globs:
 *
 *   src/domains/booking/feature  <- 'src/**\/feature' -> type:feature
 *   src/domains/booking/data     <- 'src/**\/data'    -> type:data
 *
 * feature may import data; data must not import feature.
 */
function violationsFor(file: string, config: Partial<UserSheriffConfig>) {
  const projectInfo = testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      enableBarrelLess: true,
      ...config,
    } as UserSheriffConfig),
    src: {
      'main.ts': [
        './domains/booking/feature/booking.ts',
        './domains/booking/data/booking-data.ts',
      ],
      domains: {
        booking: {
          feature: { 'booking.ts': ['../data/booking-data.ts'] },
          data: { 'booking-data.ts': ['../feature/booking.ts'] },
        },
      },
    },
  });
  return checkForDependencyRuleViolation(toFsPath(file), projectInfo);
}

const globModules = {
  modules: {
    'src/**/feature': ['type:feature'],
    'src/**/data': ['type:data'],
  },
  depRules: {
    root: '*',
    'type:feature': ['type:data'],
    'type:data': [],
  },
};

describe('dependency rules across ** modules', () => {
  it('should report the forbidden direction (data -> feature)', () => {
    const violations = violationsFor(
      '/project/src/domains/booking/data/booking-data.ts',
      globModules,
    );
    expect(violations).toHaveLength(1);
  });

  it('should allow the permitted direction (feature -> data)', () => {
    const violations = violationsFor(
      '/project/src/domains/booking/feature/booking.ts',
      globModules,
    );
    expect(violations).toHaveLength(0);
  });

  // built-in mutation probe: without the ** keys every file lands in the
  // implicit root module and module-internal imports are never checked -
  // this test must stay green so its red neighbours provably depend on **
  it('should report nothing when the ** keys are removed', () => {
    const violations = violationsFor(
      '/project/src/domains/booking/data/booking-data.ts',
      { modules: {}, depRules: { root: '*' } },
    );
    expect(violations).toHaveLength(0);
  });
});
