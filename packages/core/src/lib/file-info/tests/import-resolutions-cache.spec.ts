import { describe, expect, it } from 'vitest';
import { createProject } from '../../test/project-creator';
import { FileTree } from '../../test/project-configurator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { init } from '../../main/init';
import { toFsPath } from '../fs-path';

/**
 * Issue #49: the import-resolutions cache key contained only the tsconfig
 * path and the file path, but `resolveImports` also filters imports by the
 * per-config `ignoreFileExtensions`. In a multi-config workspace two
 * configs share the root tsconfig, so the first analysed project wrote the
 * cache entry and the second one silently reused it with the wrong filter.
 *
 * The project is created ONCE and both configs are analysed on the same
 * virtual filesystem without any write in between, so the cache entry from
 * the first run stays fresh for the second run — a cache reset between the
 * runs would hide the collision.
 */
describe('import resolutions cache key with ignoreFileExtensions', () => {
  function createMultiConfigProject(
    aAppIgnoreFileExtensions: string,
    bAppIgnoreFileExtensions: string,
  ): FileTree {
    return {
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': `
export const config = {
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
  depRules: {},
  ignoreFileExtensions: ${aAppIgnoreFileExtensions},
};
`,
          'main.ts': ['../shared/shared.ts'],
        },
        'b-app': {
          'sheriff.config.ts': `
export const config = {
  depRules: {},
  ignoreFileExtensions: ${bAppIgnoreFileExtensions},
};
`,
          'main.ts': ['../shared/shared.ts'],
        },
        shared: {
          'shared.ts': ['./style.scss'],
          'style.scss': [],
        },
      },
    };
  }

  function unresolvableImportsOfShared(entryFile: string): string[] {
    const project = init(toFsPath(entryFile));
    return project.getFileInfo(toFsPath('/project/src/shared/shared.ts'))
      .unresolvableImports;
  }

  it('should not reuse resolutions cached with another config filter', () => {
    // a-app ignores scss, b-app does not
    createProject(createMultiConfigProject(`['scss']`, `[]`));

    expect(unresolvableImportsOfShared('/project/src/a-app/main.ts')).toEqual(
      [],
    );

    // second analysis on the same filesystem, within the cache window:
    // must see the scss import because b-app does not ignore it
    expect(unresolvableImportsOfShared('/project/src/b-app/main.ts')).toEqual([
      './style.scss',
    ]);
  });

  it('should also cover the reverse direction', () => {
    // a-app does not ignore scss, b-app does
    createProject(createMultiConfigProject(`[]`, `['scss']`));

    expect(unresolvableImportsOfShared('/project/src/a-app/main.ts')).toEqual([
      './style.scss',
    ]);

    // must NOT see the scss import cached by a-app's run
    expect(unresolvableImportsOfShared('/project/src/b-app/main.ts')).toEqual(
      [],
    );
  });
});
