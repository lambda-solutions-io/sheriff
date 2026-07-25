import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkForDependencyRuleViolation } from '../../checks/check-for-dependency-rule-violation';
import { hasEncapsulationViolations } from '../../checks/has-encapsulation-violations';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { toFsPath } from '../../file-info/fs-path';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { ProjectInfo } from '../../main/init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { testInit } from '../../test/test-init';
import { calcTagsForModule } from '../../tags/calc-tags-for-module';

/**
 * `moduleIdentity` decides what makes a directory a module:
 *
 * - `'auto'` (default): the `modules` configuration **and** any barrel file.
 * - `'config'`: the `modules` configuration only.
 *
 * Every scenario below is asserted in BOTH modes, so the difference is
 * visible and pinned instead of implied.
 */
function initProject(config: Partial<UserSheriffConfig>, src: FileTree) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      enableBarrelLess: true,
      modules: {
        'src/domains/<domain>/api': ['domain:<domain>', 'type:api'],
        'src/domains/<domain>/data': ['domain:<domain>', 'type:data'],
        'src/domains/<domain>/ui': ['domain:<domain>', 'type:ui'],
      },
      depRules: {
        root: '*',
        noTag: [],
        'domain:*': '*',
        'type:*': '*',
      },
      ...config,
    }),
    src,
  });
}

/** All module paths, relative to the project root, sorted for stability. */
function modulePathsOf(projectInfo: ProjectInfo): string[] {
  return projectInfo.modules
    .map((module) => relativeToRoot(projectInfo, module.path))
    .sort();
}

/** The module a file is attributed to, plus the tags that module carries. */
function attributionOf(
  projectInfo: ProjectInfo,
  file: string,
): { module: string; tags: string[] } {
  const fileInfo = projectInfo.getFileInfo(toFsPath(`/project/${file}`));
  const modulePath = fileInfo.moduleInfo.path;

  return {
    module: relativeToRoot(projectInfo, modulePath),
    tags: calcTagsForModule(
      modulePath,
      projectInfo.rootDir,
      projectInfo.config.modules,
      projectInfo.config.autoTagging,
    ),
  };
}

/** Dependency rule violations of one file as `fromTag -> toTags` strings. */
function dependencyViolationsOf(
  projectInfo: ProjectInfo,
  file: string,
): string[] {
  return checkForDependencyRuleViolation(
    toFsPath(`/project/${file}`),
    projectInfo,
  ).map((violation) => `${violation.fromTag} -> ${violation.toTags.join(',')}`);
}

/** Encapsulation violations of one file, as the raw import strings. */
function encapsulationViolationsOf(
  projectInfo: ProjectInfo,
  file: string,
): string[] {
  return Object.keys(
    hasEncapsulationViolations(toFsPath(`/project/${file}`), projectInfo),
  );
}

function relativeToRoot(projectInfo: ProjectInfo, path: string): string {
  return getFs().relativeTo(projectInfo.rootDir, path) || '.';
}

/**
 * Case A — a stray barrel in a directory NOT covered by `modules`.
 *
 * Only the buckets `api`, `data` and `ui` are configured; the lib level
 * `src/domains/booking` is not. `booking.routes.ts` therefore belongs to the
 * root module — unless a stray `index.ts` conjures a module out of thin air.
 */
const libLevelTree = (withStrayBarrel: boolean): FileTree => ({
  'main.ts': ['./domains/booking/booking.routes'],
  domains: {
    booking: {
      'booking.routes.ts': ['./ui/booking-card'],
      ...(withStrayBarrel ? { 'index.ts': [] } : {}),
      api: { 'booking-api.ts': [] },
      data: { 'booking.store.ts': ['../api/booking-api'] },
      ui: { 'booking-card.ts': ['../data/booking.store'] },
    },
  },
});

/**
 * Case B — a stray barrel INSIDE a configured module. `src/domains/booking/ui`
 * is a configured module and stays one; only its exposure changes.
 */
const bucketLevelTree = (withStrayBarrel: boolean): FileTree => ({
  'main.ts': ['./domains/booking/ui/booking-card'],
  domains: {
    booking: {
      api: { 'booking-api.ts': [] },
      ui: {
        'booking-card.ts': [],
        ...(withStrayBarrel ? { 'index.ts': ['./booking-card'] } : {}),
      },
    },
  },
});

describe('moduleIdentity', () => {
  beforeAll(() => {
    useVirtualFs();
  });

  beforeEach(() => {
    getFs().reset();
  });

  describe("case A: stray barrel in a directory not covered by 'modules'", () => {
    it('should create a noTag module and re-route attribution under auto', () => {
      const projectInfo = initProject(
        { moduleIdentity: 'auto' },
        libLevelTree(true),
      );

      expect(modulePathsOf(projectInfo)).toEqual([
        '.',
        'src/domains/booking',
        'src/domains/booking/api',
        'src/domains/booking/data',
        'src/domains/booking/ui',
      ]);
      // the file moved out of the root module into the conjured module
      expect(
        attributionOf(projectInfo, 'src/domains/booking/booking.routes.ts'),
      ).toEqual({ module: 'src/domains/booking', tags: ['noTag'] });
      // ... and the layer matrix stops governing it: noTag has no clearance
      expect(
        dependencyViolationsOf(
          projectInfo,
          'src/domains/booking/booking.routes.ts',
        ),
      ).toEqual(['noTag -> domain:booking,type:ui']);
      // main.ts now deep-imports into a barrel module
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([
        './domains/booking/booking.routes',
      ]);
    });

    it('should create no module and keep attribution under config', () => {
      const projectInfo = initProject(
        { moduleIdentity: 'config' },
        libLevelTree(true),
      );

      expect(modulePathsOf(projectInfo)).toEqual([
        '.',
        'src/domains/booking/api',
        'src/domains/booking/data',
        'src/domains/booking/ui',
      ]);
      expect(
        attributionOf(projectInfo, 'src/domains/booking/booking.routes.ts'),
      ).toEqual({ module: '.', tags: ['root'] });
      expect(
        dependencyViolationsOf(
          projectInfo,
          'src/domains/booking/booking.routes.ts',
        ),
      ).toEqual([]);
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([]);
    });

    it('should be identical under config to the tree without the stray file', () => {
      const withStrayBarrel = initProject(
        { moduleIdentity: 'config' },
        libLevelTree(true),
      );
      const attributionWithStrayBarrel = {
        modules: modulePathsOf(withStrayBarrel),
        routes: attributionOf(
          withStrayBarrel,
          'src/domains/booking/booking.routes.ts',
        ),
        card: attributionOf(
          withStrayBarrel,
          'src/domains/booking/ui/booking-card.ts',
        ),
        violations: dependencyViolationsOf(
          withStrayBarrel,
          'src/domains/booking/booking.routes.ts',
        ),
      };

      getFs().reset();
      const withoutStrayBarrel = initProject(
        { moduleIdentity: 'config' },
        libLevelTree(false),
      );

      expect(attributionWithStrayBarrel).toEqual({
        modules: modulePathsOf(withoutStrayBarrel),
        routes: attributionOf(
          withoutStrayBarrel,
          'src/domains/booking/booking.routes.ts',
        ),
        card: attributionOf(
          withoutStrayBarrel,
          'src/domains/booking/ui/booking-card.ts',
        ),
        violations: dependencyViolationsOf(
          withoutStrayBarrel,
          'src/domains/booking/booking.routes.ts',
        ),
      });
    });
  });

  describe("case B: stray barrel inside a module covered by 'modules'", () => {
    it('should keep identity and tags but flip exposure to barrel-only under config', () => {
      const projectInfo = initProject(
        { moduleIdentity: 'config' },
        bucketLevelTree(true),
      );

      expect(modulePathsOf(projectInfo)).toEqual([
        '.',
        'src/domains/booking/api',
        'src/domains/booking/ui',
      ]);
      expect(
        attributionOf(projectInfo, 'src/domains/booking/ui/booking-card.ts'),
      ).toEqual({
        module: 'src/domains/booking/ui',
        tags: ['domain:booking', 'type:ui'],
      });
      // this is the residual, intended blast radius `barrelPolicy` reports
      expect(
        projectInfo.modules.find(
          (module) => module.path === '/project/src/domains/booking/ui',
        )?.kind,
      ).toBe('barrel');
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([
        './domains/booking/ui/booking-card',
      ]);
    });

    it('should behave the same under auto, where the module also keeps its tags', () => {
      const projectInfo = initProject(
        { moduleIdentity: 'auto' },
        bucketLevelTree(true),
      );

      expect(modulePathsOf(projectInfo)).toEqual([
        '.',
        'src/domains/booking/api',
        'src/domains/booking/ui',
      ]);
      expect(
        attributionOf(projectInfo, 'src/domains/booking/ui/booking-card.ts'),
      ).toEqual({
        module: 'src/domains/booking/ui',
        tags: ['domain:booking', 'type:ui'],
      });
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([
        './domains/booking/ui/booking-card',
      ]);
    });

    it('should expose every non-encapsulated file again once the barrel is gone', () => {
      const projectInfo = initProject(
        { moduleIdentity: 'config' },
        bucketLevelTree(false),
      );

      expect(
        projectInfo.modules.find(
          (module) => module.path === '/project/src/domains/booking/ui',
        )?.kind,
      ).toBe('barrel-less');
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([]);
    });
  });

  describe('exports', () => {
    const exportsTree: FileTree = {
      'main.ts': ['./domains/booking/api/booking.port'],
      domains: {
        booking: {
          api: {
            'booking.port.ts': [],
            'booking.impl.ts': [],
          },
        },
      },
    };

    const exportsConfig: Partial<UserSheriffConfig> = {
      modules: {
        'src/domains/<domain>/api': {
          tags: ['domain:<domain>', 'type:api'],
          exports: ['*.port.ts'],
        },
      },
    };

    it('should keep the configured exports under config', () => {
      const projectInfo = initProject(
        { ...exportsConfig, moduleIdentity: 'config' },
        exportsTree,
      );

      expect(
        projectInfo.modules.find(
          (module) => module.path === '/project/src/domains/booking/api',
        )?.exportedFilePatterns,
      ).toEqual(['*.port.ts']);
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([]);
    });

    it('should keep enforcing the exports against a non-exported file', () => {
      const projectInfo = initProject(
        { ...exportsConfig, moduleIdentity: 'config' },
        {
          ...exportsTree,
          'main.ts': ['./domains/booking/api/booking.impl'],
        },
      );

      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([
        './domains/booking/api/booking.impl',
      ]);
    });

    it('should let a barrel file win over the configured exports', () => {
      // documented precedence: inside a configured module the barrel decides
      // exposure, exactly as in `'auto'` mode, where `Module.exposes`
      // short-circuits on `hasBarrel`.
      const projectInfo = initProject(
        { ...exportsConfig, moduleIdentity: 'config' },
        {
          ...exportsTree,
          domains: {
            booking: {
              api: {
                'index.ts': ['./booking.port'],
                'booking.port.ts': [],
                'booking.impl.ts': [],
              },
            },
          },
        },
      );

      // the module keeps its configured exports ...
      expect(
        projectInfo.modules.find(
          (module) => module.path === '/project/src/domains/booking/api',
        )?.exportedFilePatterns,
      ).toEqual(['*.port.ts']);
      // ... but the barrel alone decides what is importable
      expect(encapsulationViolationsOf(projectInfo, 'src/main.ts')).toEqual([
        './domains/booking/api/booking.port',
      ]);
    });
  });

  describe('no-op guard', () => {
    it('should default to auto and produce the identical module map', () => {
      const withDefault = initProject({}, libLevelTree(true));
      const modulesWithDefault = modulePathsOf(withDefault);
      const kindsWithDefault = withDefault.modules.map((module) => module.kind);

      expect(withDefault.config.moduleIdentity).toBe('auto');

      getFs().reset();
      const withExplicitAuto = initProject(
        { moduleIdentity: 'auto' },
        libLevelTree(true),
      );

      expect(modulesWithDefault).toEqual(modulePathsOf(withExplicitAuto));
      expect(kindsWithDefault).toEqual(
        withExplicitAuto.modules.map((module) => module.kind),
      );
    });
  });
});
