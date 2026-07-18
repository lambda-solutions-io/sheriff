import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  version: 1,
  enableBarrelLess: true,
  modules: {
    'src/app/bookings/overview': ['type:consumer'],
    'src/app/customers/contract': {
      tags: ['type:api'],
      exports: ['*.port.ts'],
    },
  },
  depRules: {
    '*': '*',
    root: '*',
  },
};
