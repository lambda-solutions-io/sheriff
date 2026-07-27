import { defineConfig } from '@lambda-solutions/sheriff-core';

export const config = defineConfig({
  enableBarrelLess: true,
  modules: {
    'projects/app-i/src/app/compliant/feat': [
      'architecture:app-i',
      'app-i:type:feature',
    ],
  },
  depRules: {
    '*': '*',
    root: '*',
  },
});
