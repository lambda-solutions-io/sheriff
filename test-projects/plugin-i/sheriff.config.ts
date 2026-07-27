import { defineConfig } from '@lambda-solutions/sheriff-core';
import { JunitReporterPlugin } from 'mberger-junit-sheriff';
import { SheriffUiPlugin } from '@lambda-solutions/sheriff-ui';
import { SheriffWatchPlugin } from '@lambda-solutions/sheriff-watch';

export const config = defineConfig({
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
    new SheriffWatchPlugin(),
  ],
});
