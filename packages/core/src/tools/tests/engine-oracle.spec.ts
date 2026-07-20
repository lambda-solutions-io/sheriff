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
      }),
      src: {
        'main.ts': [
          './customer/feature/customer.ts',
          './customer/data/internal/secret.ts',
        ],
        customer: {
          feature: {
            'customer.ts': ['../data/public.ts'],
          },
          data: {
            'public.ts': [],
            internal: { 'secret.ts': [] },
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
});
