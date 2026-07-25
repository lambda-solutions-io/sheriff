import { SheriffConfig } from '@lambda-solutions/sheriff-core';

/**
 * Variant config for the `sheriff doctor` integration test: barrel-less
 * mode with an active barrel policy. The test drops stray barrels into
 * `non-compliant/util` (tagged, contains an `internal/` folder) and
 * `non-compliant/ui` (untagged) to provoke findings of checks 1–3.
 */
export const config: SheriffConfig = {
  enableBarrelLess: true,
  barrelPolicy: 'warn',
  modules: {
    'projects/app-i/src/app/non-compliant/feat': ['type:feat'],
    'projects/app-i/src/app/non-compliant/util': ['type:util'],
  },
  depRules: {
    '*': '*',
    root: '*',
  },
};
