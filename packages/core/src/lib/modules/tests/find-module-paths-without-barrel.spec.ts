import { describe, it, expect, beforeEach } from 'vitest';
import { FileTree } from '../../test/project-configurator';
import { ModuleConfig } from '../../config/module-config';
import { createProject } from '../../test/project-creator';
import { findModulePathsWithoutBarrel } from '../internal/find-module-paths-without-barrel';
import { useVirtualFs } from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';

function assertProject(fileTree: FileTree) {
  return {
    withModuleConfig(moduleConfig: ModuleConfig) {
      const run = () => {
        createProject(fileTree);
        return findModulePathsWithoutBarrel(
          moduleConfig,
          toFsPath('/project'),
          'index.ts',
        );
      };
      return {
        hasModulePaths(modulePaths: string[]) {
          expect(Array.from(run().directories)).toEqual(
            modulePaths.map((path) => `/project/${path}`),
          );
        },
        hasFileModulePaths(filePaths: string[]) {
          expect(Array.from(run().files)).toEqual(
            filePaths.map((path) => `/project/${path}`),
          );
        },
      };
    },
  };
}

describe('create module infos without barrel files', () => {
  beforeEach(() => useVirtualFs().reset());

  it('should have no modules', () => {
    assertProject({
      'src/app': {
        'app.component.ts': [
          'customers/customer.component.ts',
          'holidays/holiday.component.ts',
        ],
        'customers/customer.component.ts': [],
        'holidays/holiday.component.ts': [],
      },
    })
      .withModuleConfig({})
      .hasModulePaths([]);
  });

  it('should have modules', () => {
    assertProject({
      'src/app': {
        'app.component.ts': [],
        'domains/customers/customer.component.ts': [],
        'domains/holidays/holiday.component.ts': [],
        'shared/index.ts': [],
      },
    })
      .withModuleConfig({ 'src/app/domains/<domain>': 'domain:<domain>' })
      .hasModulePaths([
        'src/app/domains/customers',
        'src/app/domains/holidays',
      ]);
  });

  it('should use a mixed approach', () => {
    assertProject({
      'src/app': {
        'app.component.ts': [
          'customers/customer.component.ts',
          'holidays/holiday.component.ts',
        ],
        'customers/customer.component.ts': [],
        'holidays/holiday.component.ts': [],
      },
    })
      .withModuleConfig({ 'src/app/<domain>': 'domain:<domain>' })
      .hasModulePaths(['src/app/customers', 'src/app/holidays']);
  });

  it('should allow nested modules', () => {
    assertProject({
      src: {
        lib: {
          util: {
            util1: {},
            util2: {},
          },
        },
      },
    })
      .withModuleConfig({
        'src/lib': 'lib',
        'src/lib/util': 'util',
        'src/lib/util/<util>': 'util:<util>',
      })
      .hasModulePaths([
        'src/lib',
        'src/lib/util',
        'src/lib/util/util1',
        'src/lib/util/util2',
      ]);
  });

  it('should work for multiple projectPaths', () => {
    assertProject({
      src: {
        app: {
          app1: {
            feature: {},
            model: {},
          },
          app2: {
            ui: {},
          },
        },
        lib: {
          shared: {},
        },
      },
    })
      .withModuleConfig({
        'src/app/<app>/<type>': ['app:<app>', 'type:<type>'],
        'src/lib/shared': 'shared',
      })
      .hasModulePaths([
        'src/app/app1/feature',
        'src/app/app1/model',
        'src/app/app2/ui',
        'src/lib/shared',
      ]);
  });

  it('should also detect files with multiple placeholders in the same directory', () =>
    assertProject({
      src: {
        app: {
          'feature-shop': {},
          'ui-grid': {},
          'data-': {},
          model: {},
        },
      },
    })
      .withModuleConfig({
        'src/app/<type>-<name>': ['type:<type>', 'name:<name>'],
      })
      .hasModulePaths([
        'src/app/feature-shop',
        'src/app/ui-grid',
        'src/app/data-',
      ]));

    it('should ignore barrel module because findModulePathsWithBarrel handles it', () => {
      assertProject({
        src: {
          app: {
            customers: {
              'index.ts': [],
              feature: {},
              ui: {
                'index.ts': [],
              },
              data: {},
              model: {},
            },
          },
        },
      })
        .withModuleConfig({
          'src/app/<domain>': 'lib',
          'src/app/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
        })
        .hasModulePaths([
          'src/app/customers/feature',
          'src/app/customers/data',
          'src/app/customers/model',
        ]);
    });


  it('should not throw if a module does not match any directory (might be barrel module)', () => {
    assertProject({
      src: {
        app: {
          customers: {
            'index.ts': [],
            internal: {},
          },
        },
      },
    })
      .withModuleConfig({
        'src/app/<domain>': 'lib',
      })
      .hasModulePaths([]);
  });

  it('should stop after a match', () => {
    assertProject({
      src: {
        app: {
          customers: {
          },
        },
      },
    })
      .withModuleConfig({
        'src/app/<domain>': 'lib',
        'src/app/customers': 'lib',
      })
      .hasModulePaths(['src/app/customers']);
  });
});

/**
 * `includeDirectoriesWithBarrel: true` is what `moduleIdentity: 'config'`
 * passes: the `modules` configuration is the only source of module identity,
 * so a barrel file must not remove a configured directory from the result.
 */
describe('create module infos from the config only (moduleIdentity: config)', () => {
  beforeEach(() => useVirtualFs().reset());

  function assertConfigOnlyProject(fileTree: FileTree) {
    return {
      withModuleConfig(moduleConfig: ModuleConfig) {
        return {
          hasModulePaths(modulePaths: string[]) {
            createProject(fileTree);
            const actualModulePaths = findModulePathsWithoutBarrel(
              moduleConfig,
              toFsPath('/project'),
              'index.ts',
              true,
            );
            expect(Array.from(actualModulePaths.directories)).toEqual(
              modulePaths.map((path) => `/project/${path}`),
            );
          },
        };
      },
    };
  }

  it('should keep a configured directory which contains a barrel file', () => {
    assertConfigOnlyProject({
      src: {
        app: {
          customers: {
            'index.ts': [],
            feature: {},
            ui: {
              'index.ts': [],
            },
            data: {},
            model: {},
          },
        },
      },
    })
      .withModuleConfig({
        'src/app/<domain>': 'lib',
        'src/app/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
      })
      .hasModulePaths([
        'src/app/customers',
        'src/app/customers/feature',
        'src/app/customers/ui',
        'src/app/customers/data',
        'src/app/customers/model',
      ]);
  });

  it('should not add an unconfigured directory which contains a barrel file', () => {
    assertConfigOnlyProject({
      src: {
        app: {
          customers: {
            feature: {
              helpers: {
                'index.ts': [],
              },
            },
          },
          'index.ts': [],
        },
      },
    })
      .withModuleConfig({ 'src/app/<domain>/<type>': 'type:<type>' })
      .hasModulePaths(['src/app/customers/feature']);
  });

  it('should keep a configured directory which has no barrel file', () => {
    assertConfigOnlyProject({
      src: {
        app: {
          customers: {},
        },
      },
    })
      .withModuleConfig({ 'src/app/<domain>': 'domain:<domain>' })
      .hasModulePaths(['src/app/customers']);
  });
});

// regression tests for issue #56: traversal used to descend into only the
// first matching pattern per directory, silently losing sibling patterns
describe('multiple matching patterns per directory (issue #56)', () => {
  beforeEach(() => useVirtualFs().reset());

  it('should discover modules from all matching sibling patterns', () => {
    assertProject({
      'src/customers': {
        'feature/x.ts': [],
        'data/y.ts': [],
      },
    })
      .withModuleConfig({
        'src/<domain>/data': 'data',
        'src/customers/feature': 'feature',
      })
      // filesystem DFS order: 'feature' was created before 'data'
      .hasModulePaths(['src/customers/feature', 'src/customers/data']);
  });

  it('should add a terminal match even when another pattern continues deeper', () => {
    assertProject({
      'src/shared': {
        'ui/x.ts': [],
      },
    })
      .withModuleConfig({
        'src/shared': 'shared',
        'src/<x>/ui': 'ui',
      })
      .hasModulePaths(['src/shared', 'src/shared/ui']);
  });

  it('should add a directory only once when several patterns match it', () => {
    assertProject({
      'src/customers': {
        'x.ts': [],
      },
    })
      .withModuleConfig({
        'src/*': 'a',
        'src/customers': 'b',
      })
      .hasModulePaths(['src/customers']);
  });
});

// a `**` segment matches zero or more directory segments; matches driven
// purely by `**` skip node_modules and dot-directories
describe('** globs in module paths', () => {
  beforeEach(() => useVirtualFs().reset());

  it('should discover directories at any depth', () => {
    assertProject({
      libs: {
        'feature/a.ts': [],
        a: { 'feature/b.ts': [], b: { 'feature/c.ts': [] } },
      },
    })
      .withModuleConfig({ 'libs/**/feature': 'feat' })
      .hasModulePaths(['libs/feature', 'libs/a/feature', 'libs/a/b/feature']);
  });

  it('should make every directory a module with a trailing **', () => {
    assertProject({
      src: { 'a/x.ts': [], 'a/b/y.ts': [], 'c/z.ts': [] },
    })
      .withModuleConfig({ 'src/**': 'x' })
      .hasModulePaths(['src', 'src/a', 'src/a/b', 'src/c']);
  });

  it('should combine ** with partial wildcards', () => {
    assertProject({
      libs: {
        'feat-x/a.ts': [],
        deep: { 'feat-y/b.ts': [] },
        'other/c.ts': [],
      },
    })
      .withModuleConfig({ 'libs/**/feat-*': 'feat' })
      .hasModulePaths(['libs/feat-x', 'libs/deep/feat-y']);
  });

  it('should skip node_modules and dot directories for ** matches', () => {
    assertProject({
      src: {
        'a/x.ts': [],
        node_modules: { 'pkg/y.ts': [] },
        '.cache': { 'z.ts': [] },
      },
    })
      .withModuleConfig({ 'src/**': 'x' })
      .hasModulePaths(['src', 'src/a']);
  });

  it('should still match node_modules through an explicit segment', () => {
    assertProject({
      src: { node_modules: { 'pkg/y.ts': [] } },
    })
      .withModuleConfig({ 'src/node_modules/pkg': 'x' })
      .hasModulePaths(['src/node_modules/pkg']);
  });

  it('should deduplicate overlapping ** and literal patterns', () => {
    assertProject({
      src: { 'x/a.ts': [] },
    })
      .withModuleConfig({ 'src/**': 'a', 'src/x': 'b' })
      .hasModulePaths(['src', 'src/x']);
  });

  it('should exclude a ** match which contains a barrel file', () => {
    assertProject({
      libs: {
        feature: { 'index.ts': [] },
        data: { 'x.ts': [] },
      },
    })
      .withModuleConfig({ 'libs/**': 'x' })
      .hasModulePaths(['libs', 'libs/data']);
  });

  it('should keep barrel directories for ** matches with moduleIdentity config', () => {
    createProject({
      src: { app: { customers: { 'index.ts': [] } } },
    });
    const actualModulePaths = findModulePathsWithoutBarrel(
      { 'src/**': 'x' },
      toFsPath('/project'),
      'index.ts',
      true,
    );
    expect(Array.from(actualModulePaths.directories)).toEqual([
      '/project/src',
      '/project/src/app',
      '/project/src/app/customers',
    ]);
  });
});
