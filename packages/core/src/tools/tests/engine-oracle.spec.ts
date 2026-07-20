import { describe, expect, it } from 'vitest';
import { noDependencies } from '../../lib/checks/no-dependencies';
import { sameTag } from '../../lib/checks/same-tag';
import { tsConfig } from '../../lib/test/fixtures/ts-config';
import { createProject } from '../../lib/test/project-creator';
import { sheriffConfig } from '../../lib/test/project-configurator';
import { generateOracle } from '../engine-oracle';

describe('generateOracle', () => {
  it('captures barrel modules and deep imports', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/feature': 'type:feature' },
        depRules: { '*': '*' },
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': ['./feature', './feature/internal.ts'],
        feature: {
          'index.ts': ['./public.ts'],
          'public.ts': [],
          'internal.ts': [],
        },
      },
    });

    expect(generateOracle('/project')).toMatchSnapshot();
  });

  it('captures barrel-less encapsulation', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
        },
        depRules: { '*': '*' },
        enableBarrelLess: true,
        encapsulationPattern: 'private',
      }),
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
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('captures placeholder tags and dependency violations', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
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
      }),
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
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('captures external and unresolvable imports', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/domain': 'type:domain' },
        depRules: { '*': '*' },
        externalRules: { 'type:domain': ['@angular/*'] },
        enableBarrelLess: true,
      }),
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
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('preserves duplicate resolved imports with distinct raw specifiers', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/target': 'target' },
        depRules: { root: noDependencies, target: '*' },
      }),
      src: {
        'main.ts': ['./target', './target/index.ts'],
        target: { 'index.ts': [] },
      },
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('assigns files only at module path segment boundaries', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/a/b': 'module:b',
          'src/a/bc': 'module:bc',
        },
        depRules: { '*': '*' },
        enableBarrelLess: true,
      }),
      src: {
        'main.ts': ['./a/b/inside.ts', './a/bc/x.ts', './a/bx/x.ts'],
        a: {
          b: { 'inside.ts': [] },
          bc: { 'x.ts': [] },
          bx: { 'x.ts': [] },
        },
      },
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('passes resolved files to function dependency and deny rules', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
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
      }),
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
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('classifies declared but uninstalled dependencies as external', () => {
    createProject({
      'package.json': JSON.stringify({
        dependencies: { 'declared-package': '^1.0.0' },
      }),
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/domain': 'domain' },
        depRules: { '*': '*' },
        externalRules: { domain: [] },
        enableBarrelLess: true,
      }),
      src: {
        'main.ts': ['./domain/entry.ts'],
        domain: { 'entry.ts': ['declared-package/subpath'] },
      },
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('uses noTag when auto tagging does not match moduleConfig', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/manual': 'manual' },
        depRules: { '*': '*' },
        enableBarrelLess: true,
      }),
      src: {
        'main.ts': ['./automatic', './manual/entry.ts'],
        automatic: { 'index.ts': [] },
        manual: { 'entry.ts': [] },
      },
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });

  it('omits imports with configured ignored file extensions', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: { '*': '*' },
        ignoreFileExtensions: ['scss'],
      }),
      src: {
        'main.ts': ['./feature', './styles.scss'],
        'styles.scss': '',
        feature: { 'index.ts': [] },
      },
    });

    expect(generateOracle('/project/src/main.ts')).toMatchSnapshot();
  });
});
