import { SheriffConfig } from '@lambda-solutions/sheriff-core';
// Runtime import from a workspace-linked (symlinked) package: the
// integration test asserts that `sheriff verify --verbose` reports the
// real path of this build under packages/blueprint.
import { blueprintDepRules } from '@sheriff-test/blueprint';

export const config: SheriffConfig = {
  enableBarrelLess: true,
  modules: {
    'projects/app-i/src/app/compliant/feat': [
      'architecture:app-i',
      'app-i:type:feature',
    ],
  },
  depRules: blueprintDepRules,
};
