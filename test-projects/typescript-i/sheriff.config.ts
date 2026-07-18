import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const sheriffConfig: SheriffConfig = {
  version: 1,
  tagging: { 'src/<type>': '<type>' },
  depRules: {
    root: 'web',
    data: '',
    logic: 'data',
    web: 'logic',
  },
};
