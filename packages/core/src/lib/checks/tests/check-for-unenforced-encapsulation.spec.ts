import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { testInit } from '../../test/test-init';
import { checkForUnenforcedEncapsulation } from '../check-for-unenforced-encapsulation';
import '../../test/expect.extensions';

function initProject(config: Partial<UserSheriffConfig>, src: FileTree) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      ...{
        modules: { 'src/<domain>': ['domain:<domain>'] },
        depRules: { root: '*', 'domain:*': '*' },
      },
      ...config,
    }),
    src,
  });
}

function unenforcedFolders(
  config: Partial<UserSheriffConfig>,
  src: FileTree,
): { folder: string; reason: string }[] {
  const projectInfo = initProject(config, src);
  return checkForUnenforcedEncapsulation(projectInfo).map((finding) => ({
    folder: finding.folderPath.replace('/project/', ''),
    reason: finding.reason,
  }));
}

const barrelModuleWithInternal: FileTree = {
  'main.ts': ['./customers'],
  customers: {
    'index.ts': ['./internal/secret'],
    internal: {
      'secret.ts': [],
    },
  },
};

describe('checkForUnenforcedEncapsulation', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  it('should report a pattern folder when enableBarrelLess is disabled', () => {
    expect(
      unenforcedFolders({ enableBarrelLess: false }, barrelModuleWithInternal),
    ).toEqual([
      {
        folder: 'src/customers/internal',
        reason: 'barrel-less-disabled',
      },
    ]);
  });

  it('should report a pattern folder outside any module when enableBarrelLess is disabled', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: false },
        {
          'main.ts': ['./utils/internal/helper'],
          utils: {
            internal: {
              'helper.ts': [],
            },
          },
        },
      ),
    ).toEqual([
      {
        folder: 'src/utils/internal',
        reason: 'barrel-less-disabled',
      },
    ]);
  });

  it('should report a pattern folder inside a barrel module in barrel-less mode', () => {
    expect(
      unenforcedFolders({ enableBarrelLess: true }, barrelModuleWithInternal),
    ).toEqual([
      {
        folder: 'src/customers/internal',
        reason: 'module-has-barrel',
      },
    ]);
  });

  it('should not report a top-level pattern folder in a barrel-less module', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true },
        {
          'main.ts': ['./customers/api'],
          customers: {
            'api.ts': ['./internal/secret'],
            internal: {
              'secret.ts': [],
            },
          },
        },
      ),
    ).toEqual([]);
  });

  // Nested pattern folders in barrel-less modules stay unreported on
  // purpose: any-depth matching for string encapsulation patterns
  // (issue #31, task 1) enforces them — reporting them as unenforced
  // would contradict that enforcement.
  it('should not report a nested pattern folder in a barrel-less module', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true },
        {
          'main.ts': ['./customers/api'],
          customers: {
            'api.ts': ['./data/internal/secret'],
            data: {
              internal: {
                'secret.ts': [],
              },
            },
          },
        },
      ),
    ).toEqual([]);
  });

  it('should apply prefix matching to top-level folders like the enforcement does', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true },
        {
          'main.ts': ['./customers'],
          customers: {
            'index.ts': ['./internals/secret'],
            internals: {
              'secret.ts': [],
            },
          },
        },
      ),
    ).toEqual([
      {
        folder: 'src/customers/internals',
        reason: 'module-has-barrel',
      },
    ]);
  });

  it('should require an exact segment match for nested folders', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true },
        {
          'main.ts': ['./customers'],
          customers: {
            'index.ts': ['./data/internals/secret'],
            data: {
              internals: {
                'secret.ts': [],
              },
            },
          },
        },
      ),
    ).toEqual([]);
  });

  it('should not count a file named like the pattern as a folder', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true },
        {
          'main.ts': ['./customers'],
          customers: {
            'index.ts': ['./data/internal'],
            data: {
              'internal.ts': [],
            },
          },
        },
      ),
    ).toEqual([]);
  });

  it('should report a folder only once for multiple files', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true },
        {
          'main.ts': ['./customers'],
          customers: {
            'index.ts': ['./internal/secret', './internal/hidden'],
            internal: {
              'secret.ts': [],
              'hidden.ts': [],
            },
          },
        },
      ),
    ).toEqual([
      {
        folder: 'src/customers/internal',
        reason: 'module-has-barrel',
      },
    ]);
  });

  it('should support a custom string pattern', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true, encapsulationPattern: 'private' },
        {
          'main.ts': ['./customers'],
          customers: {
            'index.ts': ['./private/secret'],
            private: {
              'secret.ts': [],
            },
          },
        },
      ),
    ).toEqual([
      {
        folder: 'src/customers/private',
        reason: 'module-has-barrel',
      },
    ]);
  });

  it('should skip the scan for RegExp patterns', () => {
    expect(
      unenforcedFolders(
        { enableBarrelLess: true, encapsulationPattern: /(^|\/)internal\// },
        barrelModuleWithInternal,
      ),
    ).toEqual([]);
  });
});
