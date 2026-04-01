import { SheriffConfig } from '@softarc/sheriff-core';
import { JunitReporterPlugin } from 'mberger-junit-sheriff';
import { SheriffUiPlugin } from '@softarc/sheriff-ui';

export const config: SheriffConfig = {
  version: 1,
  entryFile: 'src/main.ts',
  modules: {
    'src/feature': 'feature',
    'src/shared': 'shared',
  },
  depRules: {
    feature: 'shared',
    shared: [],
    root: ['feature'],
  },
  plugins: [
    new SheriffUiPlugin(),
    new JunitReporterPlugin({ junitVersion: 1, reporters: ['html'] }),
  ],
};
