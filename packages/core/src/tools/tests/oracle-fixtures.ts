import { noDependencies } from '../../lib/checks/no-dependencies';
import { sameTag } from '../../lib/checks/same-tag';
import type { UserSheriffConfig } from '../../lib/config/user-sheriff-config';
import { tsConfig } from '../../lib/test/fixtures/ts-config';
import { createProject } from '../../lib/test/project-creator';
import type { FileTree } from '../../lib/test/project-configurator';
import { sheriffConfig } from '../../lib/test/project-configurator';

export interface OracleFixture {
  name: string;
  entry: string;
  config: UserSheriffConfig;
  tree: FileTree;
}

export const oracleFixtures: OracleFixture[] = [
  {
    name: 'captures barrel modules and deep imports',
    entry: '/project',
    config: {
      modules: { 'src/feature': 'type:feature' },
      depRules: { '*': '*' },
      entryFile: 'src/main.ts',
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./feature', './feature/internal.ts'],
        feature: {
          'index.ts': ['./public.ts'],
          'public.ts': [],
          'internal.ts': [],
        },
      },
    },
  },
  {
    name: 'captures barrel-less encapsulation',
    entry: '/project/src/main.ts',
    config: {
      modules: {
        'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
      },
      depRules: { '*': '*' },
      enableBarrelLess: true,
      encapsulationPattern: 'private',
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [
          './customer/feature/customer.ts',
          './customer/data/private/secret.ts',
        ],
        customer: {
          feature: {
            'customer.ts': ['../data/public.ts'],
          },
          data: {
            'public.ts': [],
            private: { 'secret.ts': [] },
          },
        },
      },
    },
  },
  {
    name: 'captures placeholder tags and dependency violations',
    entry: '/project/src/main.ts',
    config: {
      modules: {
        'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
      },
      depRules: {
        root: 'type:feature',
        'domain:*': sameTag,
        'type:feature': 'type:data',
        'type:data': noDependencies,
      },
      denyRules: { 'type:feature': 'type:data' },
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./customers/feature'],
        customers: {
          feature: {
            'index.ts': ['../data', '../../holidays/data'],
          },
          data: { 'index.ts': [] },
        },
        holidays: {
          data: { 'index.ts': [] },
        },
      },
    },
  },
  {
    name: 'captures external and unresolvable imports',
    entry: '/project/src/main.ts',
    config: {
      modules: { 'src/domain': 'type:domain' },
      depRules: { '*': '*' },
      externalRules: { 'type:domain': ['@angular/*'] },
      enableBarrelLess: true,
    },
    tree: {
      'tsconfig.json': tsConfig(),
      node_modules: {
        '@angular': { core: { 'index.ts': [] } },
        rxjs: { 'index.ts': [] },
      },
      src: {
        'main.ts': ['./domain/booking.ts'],
        domain: {
          'booking.ts': ['rxjs', '@angular/core', './missing.ts'],
        },
      },
    },
  },
  {
    name: 'preserves duplicate resolved imports with distinct raw specifiers',
    entry: '/project/src/main.ts',
    config: {
      modules: { 'src/target': 'target' },
      depRules: { root: noDependencies, target: '*' },
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./target', './target/index.ts'],
        target: { 'index.ts': [] },
      },
    },
  },
  {
    name: 'assigns files only at module path segment boundaries',
    entry: '/project/src/main.ts',
    config: {
      modules: {
        'src/a/b': 'module:b',
        'src/a/bc': 'module:bc',
      },
      depRules: { '*': '*' },
      enableBarrelLess: true,
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./a/b/inside.ts', './a/bc/x.ts', './a/bx/x.ts'],
        a: {
          b: { 'inside.ts': [] },
          bc: { 'x.ts': [] },
          bx: { 'x.ts': [] },
        },
      },
    },
  },
  {
    name: 'passes resolved files to function dependency and deny rules',
    entry: '/project/src/main.ts',
    config: {
      modules: {
        'src/source': 'source',
        'src/target': 'target',
      },
      depRules: {
        root: 'source',
        source: ({ toFilePath }) =>
          toFilePath.endsWith('/allowed.ts') ||
          toFilePath.endsWith('/denied.ts'),
        target: noDependencies,
      },
      denyRules: {
        source: ({ toFilePath }) => toFilePath.endsWith('/denied.ts'),
      },
      enableBarrelLess: true,
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./source'],
        source: {
          'index.ts': ['../target/allowed.ts', '../target/denied.ts'],
        },
        target: {
          'allowed.ts': [],
          'denied.ts': [],
        },
      },
    },
  },
  {
    name: 'classifies declared but uninstalled dependencies as external',
    entry: '/project/src/main.ts',
    config: {
      modules: { 'src/domain': 'domain' },
      depRules: { '*': '*' },
      externalRules: { domain: [] },
      enableBarrelLess: true,
    },
    tree: {
      'package.json': JSON.stringify({
        dependencies: { 'declared-package': '^1.0.0' },
      }),
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./domain/entry.ts'],
        domain: { 'entry.ts': ['declared-package/subpath'] },
      },
    },
  },
  {
    name: 'uses noTag when auto tagging does not match moduleConfig',
    entry: '/project/src/main.ts',
    config: {
      modules: { 'src/manual': 'manual' },
      depRules: { '*': '*' },
      enableBarrelLess: true,
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./automatic', './manual/entry.ts'],
        automatic: { 'index.ts': [] },
        manual: { 'entry.ts': [] },
      },
    },
  },
  {
    name: 'omits imports with configured ignored file extensions',
    entry: '/project/src/main.ts',
    config: {
      depRules: { '*': '*' },
      ignoreFileExtensions: ['scss'],
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./feature', './styles.scss'],
        'styles.scss': '',
        feature: { 'index.ts': [] },
      },
    },
  },
];

export function createOracleFixture(fixture: OracleFixture): void {
  createProject({
    ...fixture.tree,
    'sheriff.config.ts': sheriffConfig(fixture.config),
  });
}
