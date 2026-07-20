import { describe, it, expect, beforeEach } from 'vitest';
import { FileTree } from '../../test/project-configurator';
import { ModuleConfig } from '../../config/module-config';
import { createProject } from '../../test/project-creator';
import { findModulePaths, ModulePathInfo } from '../find-module-paths';
import { useVirtualFs } from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { defaultConfig } from '../../config/default-config';

const projectWithTwoModules: FileTree = {
  'src/app': {
    'app.component.ts': [
      'customers/customer.component.ts',
      'holidays/holiday.component.ts',
    ],
    'customers/customer.component.ts': [],
    'holidays/holiday.component.ts': [],
  },
};

function modulePathsFor(fileTree: FileTree, moduleConfig: ModuleConfig) {
  createProject(fileTree);
  const modulePaths = findModulePaths([], toFsPath('/project'), {
    ...defaultConfig,
    enableBarrelLess: true,
    modules: moduleConfig,
  });

  return (path: string): string[] | undefined => {
    const info = modulePaths[toFsPath(`/project/${path}`)];
    return typeof info === 'object'
      ? (info as ModulePathInfo).exports
      : undefined;
  };
}

describe('findModulePaths exports resolution', () => {
  beforeEach(() => useVirtualFs().reset());

  it('picks the most specific matching config entry', () => {
    const exportsFor = modulePathsFor(projectWithTwoModules, {
      'src/app/<domain>': { tags: ['wildcard'], exports: ['wildcard.ts'] },
      'src/app/customers': { tags: ['specific'], exports: ['specific.ts'] },
    });

    expect(exportsFor('src/app/customers')).toEqual(['specific.ts']);
    expect(exportsFor('src/app/holidays')).toEqual(['wildcard.ts']);
  });

  it('keeps declaration order when entries are equally specific', () => {
    // Both patterns match 'src/app/customers' with identical specificity
    // (three segments, two static). The previous implementation sorted
    // stably and took the first element, so the earliest-declared entry
    // has to keep winning.
    const exportsFor = modulePathsFor(projectWithTwoModules, {
      'src/<layer>/customers': { tags: ['first'], exports: ['first.ts'] },
      'src/app/<domain>': { tags: ['second'], exports: ['second.ts'] },
    });

    expect(exportsFor('src/app/customers')).toEqual(['first.ts']);
  });

  it('resolves exports independently for each module', () => {
    const exportsFor = modulePathsFor(projectWithTwoModules, {
      'src/app/customers': { tags: ['customers'], exports: ['customers.ts'] },
      'src/app/holidays': { tags: ['holidays'], exports: ['holidays.ts'] },
    });

    expect(exportsFor('src/app/customers')).toEqual(['customers.ts']);
    expect(exportsFor('src/app/holidays')).toEqual(['holidays.ts']);
  });

  it('does not re-read the module config for every module', () => {
    // Guards the O(modules x configEntries) regression. The absolute count is
    // an implementation detail; what matters is that it stays CONSTANT as the
    // number of discovered modules grows. A per-module flatten would scale
    // the reads with the module count.
    const countEntryReads = (fileTree: FileTree) => {
      let entryReads = 0;
      const moduleConfig: ModuleConfig = {};
      Object.defineProperty(moduleConfig, 'src/app/<domain>', {
        enumerable: true,
        get() {
          entryReads++;
          return { tags: ['api'], exports: ['api.ts'] };
        },
      });

      modulePathsFor(fileTree, moduleConfig);
      return entryReads;
    };

    const twoModuleReads = countEntryReads(projectWithTwoModules);

    useVirtualFs().reset();
    const eightModuleReads = countEntryReads({
      'src/app': {
        'app.component.ts': [],
        ...Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `domain-${index}/component.ts`,
            [],
          ]),
        ),
      },
    });

    expect(eightModuleReads).toBe(twoModuleReads);
  });
});
