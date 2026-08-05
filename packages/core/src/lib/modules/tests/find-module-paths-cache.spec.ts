import { describe, expect, it } from 'vitest';
import { createProject } from '../../test/project-creator';
import { FileTree } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { init } from '../../main/init';
import { toFsPath } from '../../file-info/fs-path';
import { hasEncapsulationViolations } from '../../checks/has-encapsulation-violations';

/**
 * Issue #45: the module-path cache key was built with
 * `JSON.stringify(modules)`, which drops function-valued properties
 * (tag matcher functions). Two structurally different module configs whose
 * entries are all function-valued therefore collided on the same cache key,
 * and the second analysis silently reused the first one's module paths.
 *
 * The project is created ONCE and both configs are analysed on the same
 * virtual filesystem without any write in between, so the cache entry from
 * the first run stays fresh for the second run — a cache reset between the
 * runs would hide the collision.
 */
describe('module path cache key with function-valued modules', () => {
  function createMultiConfigProject(
    aAppModules: string,
    bAppModules: string,
  ): FileTree {
    return {
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': `
export const config = {
  enableBarrelLess: true,
  depRules: {},
  configs: {
    'src/a-app': './src/a-app/sheriff.config.ts',
    'src/b-app': './src/b-app/sheriff.config.ts',
  },
};
`,
      src: {
        'a-app': {
          'sheriff.config.ts': `
export const config = {
  enableBarrelLess: true,
  depRules: {},
  modules: ${aAppModules},
};
`,
          'main.ts': ['./feature/a.component.ts'],
          feature: {
            'a.component.ts': [],
            internal: { 'hidden.service.ts': [] },
          },
        },
        'b-app': {
          'sheriff.config.ts': `
export const config = {
  enableBarrelLess: true,
  depRules: {},
  modules: ${bAppModules},
};
`,
          'main.ts': [
            './feature/b.component.ts',
            './feature/internal/hidden.service.ts',
          ],
          feature: {
            'b.component.ts': [],
            internal: { 'hidden.service.ts': [] },
          },
        },
      },
    };
  }

  function assertBAppIsAnalysedWithItsOwnModules(fileTree: FileTree) {
    createProject(fileTree);

    const aAppProject = init(toFsPath('/project/src/a-app/main.ts'));
    expect(aAppProject.modules.map(({ path }) => path)).toContain(
      '/project/src/a-app/feature',
    );

    // second analysis on the same filesystem, within the cache window
    const bAppProject = init(toFsPath('/project/src/b-app/main.ts'));
    const bAppModulePaths = bAppProject.modules.map(({ path }) => path);
    expect(bAppModulePaths).toContain('/project/src/b-app/feature');
    expect(bAppModulePaths).not.toContain('/project/src/a-app/feature');

    const violations = hasEncapsulationViolations(
      toFsPath('/project/src/b-app/main.ts'),
      bAppProject,
    );
    expect(Object.keys(violations)).toEqual(
      ['./feature/internal/hidden.service.ts'],
    );
  }

  it('should not reuse module paths cached for another config', () => {
    assertBAppIsAnalysedWithItsOwnModules(
      createMultiConfigProject(
        `{ 'src/a-app/feature': () => 'domain:a' }`,
        `{ 'src/b-app/feature': () => 'domain:b' }`,
      ),
    );
  });

  it('should also cover function leaves in nested sub-configs', () => {
    // both configs stringify to '{"src":{}}' without the fix
    assertBAppIsAnalysedWithItsOwnModules(
      createMultiConfigProject(
        `{ src: { 'a-app/feature': () => 'domain:a' } }`,
        `{ src: { 'b-app/feature': () => 'domain:b' } }`,
      ),
    );
  });

  it('should discover ** modules through the cached init pipeline', () => {
    // end-to-end guard: ** keys flow through init, the module-path cache
    // and encapsulation checks without colliding between sub-configs
    assertBAppIsAnalysedWithItsOwnModules(
      createMultiConfigProject(
        `{ 'src/a-app/**/feature': () => 'domain:a' }`,
        `{ 'src/b-app/**/feature': () => 'domain:b' }`,
      ),
    );
  });
});
