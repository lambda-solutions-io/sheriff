import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { testInit } from '../../test/test-init';
import { hasEncapsulationViolations } from '../has-encapsulation-violations';
import { checkForBarrelPolicyViolation } from '../check-for-barrel-policy-violation';
import { toFsPath } from '../../file-info/fs-path';
import { UserSheriffConfig } from '../../config/user-sheriff-config';

function initProject(config: Partial<UserSheriffConfig>, src: FileTree) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      ...{ depRules: {}, enableBarrelLess: true },
      ...config,
    }),
    src,
  });
}

function encapsulationViolationsOfMain(
  config: Partial<UserSheriffConfig>,
  src: FileTree,
): string[] {
  const projectInfo = initProject(config, src);
  return Object.keys(
    hasEncapsulationViolations(toFsPath('/project/src/main.ts'), projectInfo),
  );
}

describe('folder wildcards with digits and dots (#46)', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  it('should report a deep import into a wildcard module containing a digit', () => {
    expect(
      encapsulationViolationsOfMain(
        { modules: { 'src/feat-*': ['feat'] } },
        {
          'main.ts': ['./feat-v2/internal/hidden.service'],
          'feat-v2': {
            'feature.component.ts': [],
            internal: { 'hidden.service.ts': [] },
          },
        },
      ),
    ).toEqual(['./feat-v2/internal/hidden.service']);
  });

  it('should report a deep import into a wildcard module containing a dot', () => {
    expect(
      encapsulationViolationsOfMain(
        { modules: { 'src/lib-*': ['lib'] } },
        {
          'main.ts': ['./lib-v2.5/internal/hidden.service'],
          'lib-v2.5': {
            'lib.component.ts': [],
            internal: { 'hidden.service.ts': [] },
          },
        },
      ),
    ).toEqual(['./lib-v2.5/internal/hidden.service']);
  });

  it('should report a deep import into a placeholder module containing a digit', () => {
    expect(
      encapsulationViolationsOfMain(
        { modules: { 'src/feature-<name>': ['feat:<name>'] } },
        {
          'main.ts': ['./feature-2fa/internal/hidden.service'],
          'feature-2fa': {
            'feature.component.ts': [],
            internal: { 'hidden.service.ts': [] },
          },
        },
      ),
    ).toEqual(['./feature-2fa/internal/hidden.service']);
  });

  it('should exempt a digit-containing directory via an allowBarrelsIn glob', () => {
    const projectInfo = initProject(
      {
        modules: { 'src/<domain>': ['domain:<domain>'] },
        barrelPolicy: 'forbid',
        allowBarrelsIn: ['src/domain-*/api'],
      },
      {
        'main.ts': ['./domain-2/api'],
        'domain-2': {
          api: {
            'index.ts': ['./domain.service'],
            'domain.service.ts': [],
          },
        },
      },
    );

    expect(checkForBarrelPolicyViolation(projectInfo)).toEqual([]);
  });
});
