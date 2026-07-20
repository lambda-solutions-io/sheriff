import {
  SheriffConfig,
  sameTag,
  noDependencies,
} from '@lambda-solutions/sheriff-core';
import { JunitReporterPlugin } from 'mberger-junit-sheriff';
import { SheriffUiPlugin } from '@lambda-solutions/sheriff-ui';

export const config: SheriffConfig = {
  version: 1,
  entryFile: 'src/main.ts',
  enableBarrelLess: true,

  modules: {
    // code lives directly under src/, not src/app
    'src/feature': 'feature',
    'src/shared': 'shared',
    'src/shared/<type>': ['shared', 'shared:<type>'],
    'src/customers/api': [
      'type:api',
      'domain:customers',
      'domain:customers:api',
    ],
    'src/customers/<type>': ['domain:customers', 'type:<type>'],
  },
  depRules: {
    root: ['feature', 'shared', 'type:feature', 'shared:*'],
    feature: 'shared',
    'domain:*': [sameTag, 'shared'],
    'domain:bookings': 'domain:customers:api',
    'domain:customers:api': 'domain:customers',
    'type:api': 'type:*',
    'type:feature': [
      'type:*',
      'shared:config',
      'shared:form',
      'shared:master-data',
      'shared:ngrx-utils',
      'shared:util',
    ],
    'type:data': [
      'type:model',
      'shared:http',
      'shared:ngrx-utils',
      'shared:ui-messaging',
    ],
    'type:ui': ['type:model', 'shared:form', 'shared:ui'],
    'type:model': noDependencies,
    shared: 'shared:*',
    'shared:http': ['shared:config', 'shared:ui-messaging'],
    'shared:ngrx-utils': ['shared:util'],
  },
  plugins: [
    new SheriffUiPlugin(),
    new JunitReporterPlugin({ junitVersion: 1, reporters: ['html'] }),
  ],
};
