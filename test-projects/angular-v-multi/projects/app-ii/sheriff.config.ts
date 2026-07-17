import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  enableBarrelLess: true,
  modules: {
    'projects/app-ii/src/app/compliant/feat': [
      'architecture:app-ii',
      'app-ii:type:feature',
    ],
  },
  depRules: {
    '*': '*',
    root: '*',
  },
};
