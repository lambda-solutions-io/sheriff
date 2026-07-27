import { defineConfig } from '@lambda-solutions/sheriff-core';

export const config = defineConfig({
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
});
