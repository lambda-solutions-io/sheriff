import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  version: 1,
  enableBarrelLess: true,
  barrelPolicy: 'forbid',
  allowBarrelsIn: ['**/api'],
  modules: {
    'src/app/customers/contract': ['type:contract'],
    'src/app/customers/api': ['type:api'],
  },
  depRules: {
    '*': '*',
    root: '*',
  },
};
