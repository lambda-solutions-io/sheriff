import { SheriffConfig } from '@lambda-solutions/sheriff-core';

/**
 * Variant of the ROOT config for the `sheriff doctor` integration test of
 * check 5.
 *
 * It is the real root config plus three workspace-shaping options which
 * neither `projects/app-i/sheriff.config.ts` nor
 * `projects/app-ii/sheriff.config.ts` repeats. A sub-config is merged with
 * the defaults and never with the root config, so all three silently revert
 * to their defaults for both projects — while `sheriff verify` keeps
 * reporting success. `enableBarrelLess` is set here as well, but both
 * sub-configs do repeat it, so it must NOT be reported.
 */
export const config: SheriffConfig = {
  entryPoints: {
    'app-i': 'projects/app-i/src/main.ts',
    'app-ii': 'projects/app-ii/src/main.ts',
  },
  configs: {
    'projects/app-i': './projects/app-i/sheriff.config.ts',
    'projects/app-ii': './projects/app-ii/sheriff.config.ts',
  },
  enableBarrelLess: true,
  moduleIdentity: 'config',
  barrelPolicy: 'forbid',
  encapsulationPattern: 'hidden',
  modules: {
    'projects/app-i': {
      'src/app/non-compliant/data-access': ['type:data-access'],
      'src/app/non-compliant/feat': ['type:feat'],
      'src/app/non-compliant/types': ['type:types'],
      'src/app/non-compliant/ui': ['type:ui'],
      'src/app/non-compliant/util': ['type:util'],
    },
    'projects/app-ii': {
      'src/app/non-compliant/data-access': ['type:data-access'],
      'src/app/non-compliant/feat': ['type:feat'],
      'src/app/non-compliant/types': ['type:types'],
      'src/app/non-compliant/ui': ['type:ui'],
      'src/app/non-compliant/util': ['type:util'],
    },
  },
  depRules: {
    root: 'noTag',
    noTag: ['noTag', 'root'],
    'type:feat': ['type:ui', 'type:types', 'type:data-access', 'type:util'],
    'type:ui': ['type:ui', 'type:types', 'type:util'],
    'type:util': ['type:types', 'type:util'],
    'type:types': ['type:types'],
    'type:data-access': ['type:types', 'type:util', 'type:data-access'],
  },
};
