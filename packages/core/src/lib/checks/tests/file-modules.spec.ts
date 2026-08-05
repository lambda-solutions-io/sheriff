import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { checkForDependencyRuleViolation } from '../check-for-dependency-rule-violation';
import { hasEncapsulationViolations } from '../has-encapsulation-violations';
import { toFsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

/**
 * Single-file modules: every file matching an extension-suffixed module key
 * is its own module.
 *
 *   src/stores/user.store.ts   <- file module, ['type:store', 'store:user']
 *   src/stores/order.store.ts  <- file module, ['type:store', 'store:order']
 *   src/stores/user.store.spec.ts <- companion file, stays in the root module
 *
 * Stores must not import each other; the root module may import anything.
 */
function projectInfoWith(config: Partial<UserSheriffConfig>) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      enableBarrelLess: true,
      ...config,
    } as UserSheriffConfig),
    src: {
      'main.ts': [
        './stores/user.store.ts',
        './stores/order.store.ts',
        './stores/user.store.spec.ts',
      ],
      stores: {
        'user.store.ts': ['./order.store.ts'],
        'order.store.ts': [],
        'user.store.spec.ts': ['./user.store.ts'],
      },
    },
  });
}

const storeModules = {
  modules: {
    'src/stores/<name>.store.ts': ['type:store', 'store:<name>'],
  },
  depRules: {
    root: '*',
    'type:store': [],
  },
};

describe('file modules', () => {
  it('should report a store importing another store', () => {
    const projectInfo = projectInfoWith(storeModules);
    const violations = checkForDependencyRuleViolation(
      toFsPath('/project/src/stores/user.store.ts'),
      projectInfo,
    );
    expect(violations).toHaveLength(1);
  });

  it('should allow the root module to import stores', () => {
    const projectInfo = projectInfoWith(storeModules);
    const violations = checkForDependencyRuleViolation(
      toFsPath('/project/src/main.ts'),
      projectInfo,
    );
    expect(violations).toHaveLength(0);
  });

  it('should leave companion files in the surrounding module', () => {
    // no special treatment: the spec file is not part of the file module,
    // it belongs to the root module and needs a depRule like everyone else
    const projectInfo = projectInfoWith(storeModules);
    const violations = checkForDependencyRuleViolation(
      toFsPath('/project/src/stores/user.store.spec.ts'),
      projectInfo,
    );
    expect(violations).toHaveLength(0);
  });

  it('should expose the file module itself', () => {
    const projectInfo = projectInfoWith(storeModules);
    expect(
      hasEncapsulationViolations(
        toFsPath('/project/src/stores/user.store.ts'),
        projectInfo,
      ),
    ).toEqual({});
  });

  it('should create file modules in barrel mode too', () => {
    // no enableBarrelLess: an extension-suffixed key today matches nothing,
    // so making it work in barrel mode is additive - and it must not stay
    // silently dead there (fail-open)
    const projectInfo = projectInfoWith({
      ...storeModules,
      enableBarrelLess: false,
    });
    const violations = checkForDependencyRuleViolation(
      toFsPath('/project/src/stores/user.store.ts'),
      projectInfo,
    );
    expect(violations).toHaveLength(1);
  });

  // built-in mutation probe: without the file-module key every file lands
  // in the root module and module-internal imports are never checked
  it('should report nothing when the file-module key is removed', () => {
    const projectInfo = projectInfoWith({
      modules: {},
      depRules: { root: '*' },
    });
    const violations = checkForDependencyRuleViolation(
      toFsPath('/project/src/stores/user.store.ts'),
      projectInfo,
    );
    expect(violations).toHaveLength(0);
  });
});
