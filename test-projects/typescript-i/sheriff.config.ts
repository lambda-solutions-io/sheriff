import { defineConfig } from '@lambda-solutions/sheriff-core';

export const sheriffConfig = defineConfig({
  version: 1,
  tagging: { 'src/<type>': '<type>' },
  depRules: {
    root: 'web',
    data: '',
    logic: 'data',
    web: 'logic',
  },
});
