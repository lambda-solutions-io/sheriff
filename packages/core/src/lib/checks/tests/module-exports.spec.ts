import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { hasEncapsulationViolations } from '../has-encapsulation-violations';
import { calcTagsForModule } from '../../tags/calc-tags-for-module';
import { toFsPath } from '../../file-info/fs-path';
import '../../test/expect.extensions';

/**
 * A slice with a port module whose contract is public and whose HTTP adapter
 * must stay invisible from the outside:
 *
 *   src/booking/api/booking.port.ts   <- public contract
 *   src/booking/api/http-booking.ts   <- implementation, hidden
 *   src/booking/feature/booking.ts    <- other module, imports both
 */
function createProjectInfo(config: Partial<UserSheriffConfig>) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      depRules: { '*': '*' },
      enableBarrelLess: true,
      ...config,
    } as UserSheriffConfig),
    src: {
      'main.ts': ['./booking/feature/booking.ts'],
      booking: {
        api: {
          'booking.port.ts': [],
          'http-booking.ts': [],
        },
        feature: {
          'booking.ts': [
            '../api/booking.port.ts',
            '../api/http-booking.ts',
          ],
        },
      },
    },
  });
}

function violatedImportsFor(config: Partial<UserSheriffConfig>) {
  const projectInfo = createProjectInfo(config);
  return Object.keys(
    hasEncapsulationViolations(
      toFsPath('/project/src/booking/feature/booking.ts'),
      projectInfo,
    ),
  );
}

/**
 * The object form of a module: `tags` plus the new `exports`.
 */
const modulesWithExports = {
  'src/booking/api': {
    tags: ['type:api'],
    exports: ['*.port.ts'],
  },
  'src/booking/feature': ['type:feature'],
};

describe('module exports', () => {
  describe('the object form must be distinguishable from a nested ModuleConfig', () => {
    it('should assign the tags of a module declared in object form', () => {
      // `{ tags, exports }` must NOT be mistaken for a nested ModuleConfig.
      // Today `isTagConfigValue` treats every non-array object as nesting,
      // so this throws TagWithoutValueError instead of returning the tags.
      const projectInfo = createProjectInfo({ modules: modulesWithExports });

      expect(
        calcTagsForModule(
          toFsPath('/project/src/booking/api'),
          projectInfo.rootDir,
          projectInfo.config.modules,
          projectInfo.config.autoTagging,
        ),
      ).toEqual(['type:api']);
    });

    it('should still support a nested ModuleConfig', () => {
      // the regression guard for the discriminator: an object WITHOUT `tags`
      // must keep being traversed as a nested ModuleConfig
      const projectInfo = createProjectInfo({
        modules: {
          'src/booking': {
            api: ['type:api'],
            feature: ['type:feature'],
          },
        },
      });

      expect(
        calcTagsForModule(
          toFsPath('/project/src/booking/api'),
          projectInfo.rootDir,
          projectInfo.config.modules,
          projectInfo.config.autoTagging,
        ),
      ).toEqual(['type:api']);
    });

    it('should support a single string tag in object form', () => {
      const projectInfo = createProjectInfo({
        modules: {
          'src/booking/api': { tags: 'type:api', exports: ['*.port.ts'] },
          'src/booking/feature': ['type:feature'],
        },
      });

      expect(
        calcTagsForModule(
          toFsPath('/project/src/booking/api'),
          projectInfo.rootDir,
          projectInfo.config.modules,
          projectInfo.config.autoTagging,
        ),
      ).toEqual(['type:api']);
    });
  });

  describe('exports restricts visibility below folder level', () => {
    it('should report an import of a non-exported file from outside', () => {
      expect(violatedImportsFor({ modules: modulesWithExports })).toEqual([
        '../api/http-booking.ts',
      ]);
    });

    it('should allow an import of an exported file from outside', () => {
      // The counter-proof: the port stays importable while its neighbour does
      // not. Asserted as an exact list, because `not.toContain` would also
      // hold for an empty result and thus pass vacuously.
      expect(violatedImportsFor({ modules: modulesWithExports })).toEqual([
        '../api/http-booking.ts',
      ]);
    });

    it('should allow every file when exports is absent', () => {
      // the control and mutation probe: without `exports` nothing is hidden,
      // which is exactly the gap the feature closes
      expect(
        violatedImportsFor({
          modules: {
            'src/booking/api': ['type:api'],
            'src/booking/feature': ['type:feature'],
          },
        }),
      ).toEqual([]);
    });

    it('should allow every file for an empty exports list', () => {
      // `exports: []` exports nothing - every outside import is a violation
      expect(
        violatedImportsFor({
          modules: {
            'src/booking/api': { tags: ['type:api'], exports: [] },
            'src/booking/feature': ['type:feature'],
          },
        }),
      ).toEqual(['../api/booking.port.ts', '../api/http-booking.ts']);
    });

    it('should treat every export pattern as an alternative', () => {
      // Two patterns, only the second of which matches `http-booking.ts`.
      // Expecting `[]` alone would pass vacuously today, so the discriminating
      // case is the third file, which no pattern matches.
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/booking/api': {
              tags: ['type:api'],
              exports: ['*.port.ts', 'http-*.ts'],
            },
            'src/booking/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./booking/feature/booking.ts'],
          booking: {
            api: {
              'booking.port.ts': [],
              'http-booking.ts': [],
              'secret.ts': [],
            },
            feature: {
              'booking.ts': [
                '../api/booking.port.ts',
                '../api/http-booking.ts',
                '../api/secret.ts',
              ],
            },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/booking/feature/booking.ts'),
            projectInfo,
          ),
        ),
      ).toEqual(['../api/secret.ts']);
    });

    it('should not let root-level file patterns match nested files', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/booking/api': {
              tags: ['type:api'],
              exports: ['*.port.ts'],
            },
            'src/booking/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./booking/feature/booking.ts'],
          booking: {
            api: {
              'booking.port.ts': [],
              admin: {
                'admin.port.ts': [],
              },
            },
            feature: {
              'booking.ts': [
                '../api/booking.port.ts',
                '../api/admin/admin.port.ts',
              ],
            },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/booking/feature/booking.ts'),
            projectInfo,
          ),
        ),
      ).toEqual(['../api/admin/admin.port.ts']);
    });

    it('should match an explicit one-level subfolder export pattern', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/booking/api': {
              tags: ['type:api'],
              exports: ['sub/*.ts'],
            },
            'src/booking/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./booking/feature/booking.ts'],
          booking: {
            api: {
              sub: {
                'public.ts': [],
                deep: {
                  'private.ts': [],
                },
              },
            },
            feature: {
              'booking.ts': [
                '../api/sub/public.ts',
                '../api/sub/deep/private.ts',
              ],
            },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/booking/feature/booking.ts'),
            projectInfo,
          ),
        ),
      ).toEqual(['../api/sub/deep/private.ts']);
    });

    it('should let exports override the default internal folder convention', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/booking/api': {
              tags: ['type:api'],
              exports: ['internal/public.ts'],
            },
            'src/booking/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./booking/feature/booking.ts'],
          booking: {
            api: {
              internal: {
                'public.ts': [],
              },
            },
            feature: {
              'booking.ts': ['../api/internal/public.ts'],
            },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/booking/feature/booking.ts'),
            projectInfo,
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('exports are attached to the matched module key only', () => {
    it('should let an exact module without exports beat a wildcard module with exports', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/app/special': ['type:special'],
            'src/app/*': { tags: ['type:generic'], exports: ['public.ts'] },
            'src/app/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./app/feature/use.ts'],
          app: {
            special: {
              'public.ts': [],
              'secret.ts': [],
            },
            feature: {
              'use.ts': ['../special/public.ts', '../special/secret.ts'],
            },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/app/feature/use.ts'),
            projectInfo,
          ),
        ),
      ).toEqual([]);
    });

    it('should apply wildcard exports when the wildcard is the most specific match', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/app/*': { tags: ['type:generic'], exports: ['public.ts'] },
            'src/app/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./app/feature/use.ts'],
          app: {
            special: {
              'public.ts': [],
              'secret.ts': [],
            },
            feature: {
              'use.ts': ['../special/public.ts', '../special/secret.ts'],
            },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/app/feature/use.ts'),
            projectInfo,
          ),
        ),
      ).toEqual(['../special/secret.ts']);
    });

    it('should not inherit exports from a shallower wildcard module key', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/*': { tags: ['type:parent'], exports: ['a.ts'] },
            'src/*/b': ['type:child'],
            'app/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['../app/feature/use.ts'],
          x: {
            b: {
              'c.ts': [],
            },
          },
        },
        app: {
          feature: {
            'use.ts': ['../../src/x/b/c.ts'],
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/app/feature/use.ts'),
            projectInfo,
          ),
        ),
      ).toEqual([]);
    });

    it('should not inherit exports from a shallower placeholder module key', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/<domain>': { tags: ['type:parent'], exports: ['a.ts'] },
            'src/<domain>/b': ['type:child'],
            'app/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['../app/feature/use.ts'],
          x: {
            b: {
              'c.ts': [],
            },
          },
        },
        app: {
          feature: {
            'use.ts': ['../../src/x/b/c.ts'],
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/app/feature/use.ts'),
            projectInfo,
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('exports does not apply within the same module', () => {
    it('should not report a module-internal import of a non-exported file', () => {
      const projectInfo = testInit('src/main.ts', {
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/booking/api': { tags: ['type:api'], exports: ['*.port.ts'] },
            'src/booking/feature': ['type:feature'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
        } as UserSheriffConfig),
        src: {
          'main.ts': ['./booking/feature/booking.ts'],
          booking: {
            api: {
              // the port imports its own neighbour - same module, always fine
              'booking.port.ts': ['./http-booking.ts'],
              'http-booking.ts': [],
            },
            feature: { 'booking.ts': ['../api/booking.port.ts'] },
          },
        },
      });

      expect(
        Object.keys(
          hasEncapsulationViolations(
            toFsPath('/project/src/booking/api/booking.port.ts'),
            projectInfo,
          ),
        ),
      ).toEqual([]);
    });
  });
});
