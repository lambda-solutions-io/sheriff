import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { testInit } from '../../test/test-init';
import { checkForBarrelPolicyViolation } from '../check-for-barrel-policy-violation';
import { checkForDependencyRuleViolation } from '../check-for-dependency-rule-violation';
import { toFsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

function initProject(config: Partial<UserSheriffConfig>, src: FileTree) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      ...{
        modules: { 'src/<domain>': ['domain:<domain>'] },
        depRules: { root: '*', 'domain:*': '*' },
        enableBarrelLess: true,
      },
      ...config,
    }),
    src,
  });
}

function violatedBarrelFiles(
  config: Partial<UserSheriffConfig>,
  src: FileTree,
): string[] {
  const projectInfo = initProject(config, src);
  return checkForBarrelPolicyViolation(projectInfo).map((violation) =>
    violation.barrelFilePath.replace('/project/', ''),
  );
}

const strayBarrelTree: FileTree = {
  'main.ts': ['./ui/customer.component'],
  ui: {
    'customer.component.ts': [],
    'index.ts': [],
  },
};

const barrelLessTree: FileTree = {
  'main.ts': ['./ui/customer.component'],
  ui: {
    'customer.component.ts': [],
  },
};

describe('checkForBarrelPolicyViolation', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  describe('policy matrix', () => {
    it('should not report with allow and a stray barrel', () => {
      expect(
        violatedBarrelFiles({ barrelPolicy: 'allow' }, strayBarrelTree),
      ).toEqual([]);
    });

    it('should not report with allow and no barrel', () => {
      expect(
        violatedBarrelFiles({ barrelPolicy: 'allow' }, barrelLessTree),
      ).toEqual([]);
    });

    it('should report with warn and a stray barrel', () => {
      expect(
        violatedBarrelFiles({ barrelPolicy: 'warn' }, strayBarrelTree),
      ).toEqual(['src/ui/index.ts']);
    });

    it('should not report with warn and no barrel', () => {
      expect(
        violatedBarrelFiles({ barrelPolicy: 'warn' }, barrelLessTree),
      ).toEqual([]);
    });

    it('should report with forbid and a stray barrel', () => {
      expect(
        violatedBarrelFiles({ barrelPolicy: 'forbid' }, strayBarrelTree),
      ).toEqual(['src/ui/index.ts']);
    });

    it('should not report with forbid and no barrel', () => {
      expect(
        violatedBarrelFiles({ barrelPolicy: 'forbid' }, barrelLessTree),
      ).toEqual([]);
    });

    it('should not report a matching allowBarrelsIn glob', () => {
      expect(
        violatedBarrelFiles(
          { barrelPolicy: 'forbid', allowBarrelsIn: ['src/ui'] },
          strayBarrelTree,
        ),
      ).toEqual([]);
    });

    it('should report a non-matching allowBarrelsIn glob', () => {
      expect(
        violatedBarrelFiles(
          { barrelPolicy: 'forbid', allowBarrelsIn: ['src/api'] },
          strayBarrelTree,
        ),
      ).toEqual(['src/ui/index.ts']);
    });
  });

  it('should not report when barrel-less mode is disabled', () => {
    // parse-config rejects barrelPolicy without enableBarrelLess, so the
    // guard inside the check is exercised with a modified configuration.
    const projectInfo = initProject(
      { barrelPolicy: 'forbid' },
      strayBarrelTree,
    );
    expect(
      checkForBarrelPolicyViolation({
        ...projectInfo,
        config: { ...projectInfo.config, enableBarrelLess: false },
      }),
    ).toEqual([]);
  });

  it('should report modulePath, barrelFilePath and a message naming the consequence', () => {
    const projectInfo = initProject(
      { barrelPolicy: 'forbid' },
      strayBarrelTree,
    );
    const violations = checkForBarrelPolicyViolation(projectInfo);

    expect(violations).toEqual([
      {
        modulePath: '/project/src/ui',
        barrelFilePath: '/project/src/ui/index.ts',
        message:
          'index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
      },
    ]);
  });

  it('should use the configured barrelFileName', () => {
    const violations = checkForBarrelPolicyViolation(
      initProject(
        { barrelPolicy: 'forbid', barrelFileName: 'public-api.ts' },
        {
          'main.ts': ['./ui/customer.component'],
          ui: {
            'customer.component.ts': [],
            'public-api.ts': [],
          },
        },
      ),
    );

    expect(violations).toEqual([
      {
        modulePath: '/project/src/ui',
        barrelFilePath: '/project/src/ui/public-api.ts',
        message:
          'public-api.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
      },
    ]);
  });

  describe('issue repro: bucket barrels stay legal, lib barrels are flagged', () => {
    const bucketTree: FileTree = {
      'main.ts': ['./customers/feature/customers.component'],
      customers: {
        'index.ts': [],
        api: {
          'index.ts': [],
          'customers.port.ts': [],
        },
        feature: {
          'customers.component.ts': ['../api/customers.port'],
        },
      },
    };

    const bucketConfig: Partial<UserSheriffConfig> = {
      modules: {
        'src/<domain>': ['domain:<domain>'],
        'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
      },
    };

    it('should flag every barrel under forbid without exceptions', () => {
      expect(
        violatedBarrelFiles(
          { ...bucketConfig, barrelPolicy: 'forbid' },
          bucketTree,
        ),
      ).toEqual(['src/customers/index.ts', 'src/customers/api/index.ts']);
    });

    it('should keep the api bucket barrel legal via **/api and still flag the lib barrel', () => {
      expect(
        violatedBarrelFiles(
          {
            ...bucketConfig,
            barrelPolicy: 'forbid',
            allowBarrelsIn: ['**/api'],
          },
          bucketTree,
        ),
      ).toEqual(['src/customers/index.ts']);
    });

    it('should keep blocking ui -> api via dependency rules while the api barrel is allowed', () => {
      const projectInfo = initProject(
        {
          modules: { 'src/customers/<type>': ['type:<type>'] },
          depRules: {
            root: '*',
            'type:api': '*',
            'type:ui': [],
          },
          barrelPolicy: 'forbid',
          allowBarrelsIn: ['**/api'],
        },
        {
          'main.ts': ['./customers/ui/customer.component'],
          customers: {
            api: {
              'index.ts': ['./customers.port'],
              'customers.port.ts': [],
            },
            ui: {
              'customer.component.ts': ['../api'],
            },
          },
        },
      );

      // the allowed barrel produces no barrel policy violation ...
      expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([]);

      // ... but allowBarrelsIn only legalizes the barrel file itself:
      // ui -> api still has to pass the dependency rules.
      const dependencyRuleViolations = checkForDependencyRuleViolation(
        toFsPath('/project/src/customers/ui/customer.component.ts'),
        projectInfo,
      );
      expect(dependencyRuleViolations).toHaveLength(1);
      expect(dependencyRuleViolations[0].fromTag).toBe('type:ui');
      expect(dependencyRuleViolations[0].toTags).toEqual(['type:api']);
    });

    it('should support single-segment wildcards in allowBarrelsIn', () => {
      expect(
        violatedBarrelFiles(
          {
            ...bucketConfig,
            barrelPolicy: 'forbid',
            allowBarrelsIn: ['src/*/api'],
          },
          bucketTree,
        ),
      ).toEqual(['src/customers/index.ts']);
    });
  });

  /**
   * With `moduleIdentity: 'config'` a barrel file creates no module, so the
   * module-driven scan alone would go blind to exactly the most dangerous
   * case: a stray barrel in a directory no `modules` pattern covers.
   */
  describe("moduleIdentity: 'config'", () => {
    // only the buckets are configured; `src/customers` itself is not
    const configOnlyModules: Partial<UserSheriffConfig> = {
      modules: { 'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'] },
    };

    const strayLibBarrelTree: FileTree = {
      'main.ts': ['./customers/ui/customer.component'],
      customers: {
        'index.ts': [],
        ui: {
          'customer.component.ts': [],
        },
      },
    };

    it('should report a barrel outside any configured module with forbid', () => {
      expect(
        violatedBarrelFiles(
          {
            ...configOnlyModules,
            moduleIdentity: 'config',
            barrelPolicy: 'forbid',
          },
          strayLibBarrelTree,
        ),
      ).toEqual(['src/customers/index.ts']);
    });

    it('should report a barrel outside any configured module with warn', () => {
      expect(
        violatedBarrelFiles(
          {
            ...configOnlyModules,
            moduleIdentity: 'config',
            barrelPolicy: 'warn',
          },
          strayLibBarrelTree,
        ),
      ).toEqual(['src/customers/index.ts']);
    });

    it('should stay silent with allow', () => {
      expect(
        violatedBarrelFiles(
          {
            ...configOnlyModules,
            moduleIdentity: 'config',
            barrelPolicy: 'allow',
          },
          strayLibBarrelTree,
        ),
      ).toEqual([]);
    });

    it('should suppress it via a matching allowBarrelsIn pattern', () => {
      expect(
        violatedBarrelFiles(
          {
            ...configOnlyModules,
            moduleIdentity: 'config',
            barrelPolicy: 'forbid',
            allowBarrelsIn: ['src/*'],
          },
          strayLibBarrelTree,
        ),
      ).toEqual([]);
    });

    it('should keep reporting it for a non-matching allowBarrelsIn pattern', () => {
      expect(
        violatedBarrelFiles(
          {
            ...configOnlyModules,
            moduleIdentity: 'config',
            barrelPolicy: 'forbid',
            allowBarrelsIn: ['**/api'],
          },
          strayLibBarrelTree,
        ),
      ).toEqual(['src/customers/index.ts']);
    });

    it('should use a message which fits a directory that is not a module', () => {
      const projectInfo = initProject(
        {
          ...configOnlyModules,
          moduleIdentity: 'config',
          barrelPolicy: 'forbid',
        },
        strayLibBarrelTree,
      );

      expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([
        {
          modulePath: '/project/src/customers',
          barrelFilePath: '/project/src/customers/index.ts',
          message:
            "index.ts sits outside any module configured via `modules`. With moduleIdentity: 'config' it creates no module and has no effect on encapsulation. Remove it, add its directory to `modules`, or add it to `allowBarrelsIn`.",
        },
      ]);
    });

    it('should report a module barrel and an outside barrel exactly once each', () => {
      const projectInfo = initProject(
        {
          ...configOnlyModules,
          moduleIdentity: 'config',
          barrelPolicy: 'forbid',
        },
        {
          'main.ts': ['./customers/api'],
          customers: {
            'index.ts': [],
            api: {
              'index.ts': ['./customers.port'],
              'customers.port.ts': [],
            },
          },
        },
      );

      const violations = checkForBarrelPolicyViolation(projectInfo);
      expect(
        violations.map((violation) =>
          violation.barrelFilePath.replace('/project/', ''),
        ),
      ).toEqual(['src/customers/api/index.ts', 'src/customers/index.ts']);
      // the configured module keeps the module-flavoured message
      expect(violations[0].message).toContain(
        'turns a barrel-less module into a barrel module',
      );
      expect(violations[1].message).toContain(
        'sits outside any module configured via',
      );
    });

    it('should not change anything under moduleIdentity auto', () => {
      // under 'auto' the very same stray barrel IS a module, so it is
      // reported through the module scan with the module-flavoured message.
      const projectInfo = initProject(
        {
          ...configOnlyModules,
          moduleIdentity: 'auto',
          barrelPolicy: 'forbid',
        },
        strayLibBarrelTree,
      );

      expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([
        {
          modulePath: '/project/src/customers',
          barrelFilePath: '/project/src/customers/index.ts',
          message:
            'index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
        },
      ]);
    });
  });

  /**
   * The root module is always barrel-less by construction (`createModules`
   * overwrites it), so a root-level barrel file creates no barrel module
   * and used to slip past the module-driven scan entirely (issue #48).
   */
  describe('root-level barrel (issue #48)', () => {
    // project files live directly in the root, next to sheriff.config.ts
    function initRootProject(
      config: Partial<UserSheriffConfig>,
      files: FileTree,
    ) {
      return testInit('main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          ...{
            modules: { '<domain>': ['domain:<domain>'] },
            depRules: { root: '*', 'domain:*': '*' },
            enableBarrelLess: true,
          },
          ...config,
        }),
        ...files,
      });
    }

    const rootBarrelFiles: FileTree = {
      'main.ts': ['./ui/customer.component'],
      'index.ts': [],
      ui: {
        'customer.component.ts': [],
      },
    };

    it('should report a root barrel with forbid and a root-flavoured message', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'forbid' },
        rootBarrelFiles,
      );

      expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([
        {
          modulePath: '/project',
          barrelFilePath: '/project/index.ts',
          message:
            'index.ts sits in the project root. The root module is always barrel-less, so the file has no effect on encapsulation. Remove it or add `.` to `allowBarrelsIn`.',
        },
      ]);
    });

    it('should report a root barrel with warn', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'warn' },
        rootBarrelFiles,
      );

      expect(
        checkForBarrelPolicyViolation(projectInfo).map(
          (violation) => violation.barrelFilePath,
        ),
      ).toEqual(['/project/index.ts']);
    });

    it('should not report a root barrel with allow', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'allow' },
        rootBarrelFiles,
      );

      expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([]);
    });

    it("should report a root barrel under moduleIdentity 'config' as well", () => {
      const projectInfo = initRootProject(
        { moduleIdentity: 'config', barrelPolicy: 'forbid' },
        rootBarrelFiles,
      );

      expect(
        checkForBarrelPolicyViolation(projectInfo).map(
          (violation) => violation.barrelFilePath,
        ),
      ).toEqual(['/project/index.ts']);
    });

    it('should suppress a root barrel via `.` in allowBarrelsIn', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'forbid', allowBarrelsIn: ['.'] },
        rootBarrelFiles,
      );

      expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([]);
    });

    it('should keep reporting a root barrel for a non-matching allowBarrelsIn glob', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'forbid', allowBarrelsIn: ['ui'] },
        rootBarrelFiles,
      );

      expect(
        checkForBarrelPolicyViolation(projectInfo).map(
          (violation) => violation.barrelFilePath,
        ),
      ).toEqual(['/project/index.ts']);
    });

    it('should use the configured barrelFileName for the root barrel', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'forbid', barrelFileName: 'public-api.ts' },
        {
          'main.ts': ['./ui/customer.component'],
          'public-api.ts': [],
          ui: {
            'customer.component.ts': [],
          },
        },
      );

      expect(
        checkForBarrelPolicyViolation(projectInfo).map(
          (violation) => violation.barrelFilePath,
        ),
      ).toEqual(['/project/public-api.ts']);
    });

    it('should report a barrel next to tsconfig.json in an src layout too', () => {
      // entry below src: the root module still owns the rootDir, so the
      // stray barrel beside tsconfig.json is just as inert.
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: { 'src/<domain>': ['domain:<domain>'] },
          depRules: { root: '*', 'domain:*': '*' },
          enableBarrelLess: true,
          barrelPolicy: 'forbid',
        }),
        'index.ts': [],
        src: {
          'main.ts': ['./ui/customer.component'],
          ui: {
            'customer.component.ts': [],
          },
        },
      });

      expect(
        checkForBarrelPolicyViolation(projectInfo).map(
          (violation) => violation.barrelFilePath,
        ),
      ).toEqual(['/project/index.ts']);
    });

    it('should report a root barrel and a module barrel exactly once each', () => {
      const projectInfo = initRootProject(
        { barrelPolicy: 'forbid' },
        {
          'main.ts': ['./ui/customer.component'],
          'index.ts': [],
          ui: {
            'customer.component.ts': [],
            'index.ts': [],
          },
        },
      );

      const violations = checkForBarrelPolicyViolation(projectInfo);
      expect(violations.map((violation) => violation.barrelFilePath)).toEqual([
        '/project/ui/index.ts',
        '/project/index.ts',
      ]);
      expect(violations[0].message).toContain(
        'turns a barrel-less module into a barrel module',
      );
      expect(violations[1].message).toContain('sits in the project root');
    });

    it("should report a root barrel and an outside barrel under 'config' exactly once each", () => {
      const projectInfo = initRootProject(
        { moduleIdentity: 'config', modules: {}, barrelPolicy: 'forbid' },
        {
          'main.ts': ['./ui/customer.component'],
          'index.ts': [],
          ui: {
            'customer.component.ts': [],
            'index.ts': [],
          },
        },
      );

      expect(
        checkForBarrelPolicyViolation(projectInfo).map(
          (violation) => violation.barrelFilePath,
        ),
      ).toEqual(['/project/ui/index.ts', '/project/index.ts']);
    });
  });
});
