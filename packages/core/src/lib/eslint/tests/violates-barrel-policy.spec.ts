import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { testInit } from '../../test/test-init';
import { violatesBarrelPolicy } from '../violates-barrel-policy';
import '../../test/expect.extensions';

const barrelPolicyMessage =
  'index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.';

function setupProject(config: Partial<UserSheriffConfig>, src?: FileTree) {
  testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      ...{
        modules: { 'src/<domain>': ['domain:<domain>'] },
        depRules: { root: '*', 'domain:*': '*' },
        enableBarrelLess: true,
      },
      ...config,
    }),
    src: src ?? {
      'main.ts': ['./ui/customer.component'],
      ui: {
        'customer.component.ts': [],
        'index.ts': ['./customer.component'],
      },
    },
  });
}

function lint(filename: string): string {
  return violatesBarrelPolicy(
    filename,
    getFs().readFile(toFsPath(filename)),
  );
}

// the canonical Issue-31 footgun: a completely empty stray index.ts
const emptyBarrelTree: FileTree = {
  'main.ts': ['./ui/customer.component'],
  ui: {
    'customer.component.ts': [],
    'empty.helper.ts': [],
    'index.ts': [],
  },
};

describe('violatesBarrelPolicy', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  it('should report on the barrel file itself under forbid', () => {
    setupProject({ barrelPolicy: 'forbid' });
    expect(lint('/project/src/ui/index.ts')).toBe(barrelPolicyMessage);
  });

  it('should not report under warn - warn is verify-only', () => {
    setupProject({ barrelPolicy: 'warn' });
    expect(lint('/project/src/ui/index.ts')).toBe('');
  });

  it('should report an empty stray barrel file under forbid', () => {
    setupProject({ barrelPolicy: 'forbid' }, emptyBarrelTree);
    expect(lint('/project/src/ui/index.ts')).toBe(barrelPolicyMessage);
  });

  it('should not report an empty stray barrel file under the default policy', () => {
    setupProject({}, emptyBarrelTree);
    expect(lint('/project/src/ui/index.ts')).toBe('');
  });

  it('should not report an empty barrel file allowed via allowBarrelsIn', () => {
    setupProject(
      { barrelPolicy: 'forbid', allowBarrelsIn: ['**/ui'] },
      emptyBarrelTree,
    );
    expect(lint('/project/src/ui/index.ts')).toBe('');
  });

  it('should not report an empty non-barrel file', () => {
    setupProject({ barrelPolicy: 'forbid' }, emptyBarrelTree);
    expect(lint('/project/src/ui/empty.helper.ts')).toBe('');
  });

  it('should not report on a regular file of the module', () => {
    setupProject({ barrelPolicy: 'forbid' });
    expect(lint('/project/src/ui/customer.component.ts')).toBe('');
  });

  it('should not report with the default policy', () => {
    setupProject({});
    expect(lint('/project/src/ui/index.ts')).toBe('');
  });

  it('should not report a barrel allowed via allowBarrelsIn', () => {
    setupProject({
      barrelPolicy: 'forbid',
      allowBarrelsIn: ['**/ui'],
    });
    expect(lint('/project/src/ui/index.ts')).toBe('');
  });

  it('should not report without a sheriff.config.ts', () => {
    testInit('src/main.ts', {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./ui/index'],
        ui: {
          'customer.component.ts': [],
          'index.ts': ['./customer.component'],
        },
      },
    });

    expect(lint('/project/src/ui/index.ts')).toBe('');
  });
});
