import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as ts from 'typescript';
import { parseConfig } from '../parse-config';
import { toFsPath } from '../../file-info/fs-path';
import getFs, { useVirtualFs } from '../../fs/getFs';
import {
  CollidingEncapsulationSettings,
  CollidingEntrySettings,
  MissingModulesWithoutAutoTaggingError,
  NoEntryPointsFoundError,
  TaggingAndModulesError,
} from '../../error/user-error';
import '../../test/expect.extensions';
import { defaultIgnoreFileExtensions } from '../default-file-extensions';

describe('parse Config', () => {
  it('should read value', () => {
    const source = 'export const a = 1';

    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.NodeNext },
    });

    expect(outputText).toMatchSnapshot();
  });

  it('should the sheriff config', () => {
    const tsCode = parseConfig(
      toFsPath(__dirname + '/../../test/sheriff.config.ts'),
    );
    expect(Object.keys(tsCode)).toEqual([
      'version',
      'autoTagging',
      'modules',
      'depRules',
      'denyRules',
      'externalRules',
      'configs',
      'excludeRoot',
      'enableBarrelLess',
      'encapsulationPattern',
      'log',
      'entryFile',
      'isConfigFileMissing',
      'barrelFileName',
      'entryPoints',
      'ignoreFileExtensions',
      'configImports',
    ]);
  });

  describe('virtual fs', () => {
    beforeAll(() => {
      useVirtualFs();
    });

    beforeEach(() => {
      getFs().reset();
    });

    it('should set default values', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: {
    'noTag': 'noTag',
  },
};
      `,
      );

      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );
      expect(config).toEqual({
        version: 1,
        autoTagging: true,
        modules: {},
        depRules: { noTag: 'noTag' },
        denyRules: {},
        externalRules: {},
        configs: {},
        enableBarrelLess: false,
        encapsulationPattern: 'internal',
        excludeRoot: false,
        log: false,
        isConfigFileMissing: false,
        entryFile: '',
        barrelFileName: 'index.ts',
        entryPoints: undefined,
        ignoreFileExtensions: defaultIgnoreFileExtensions,
        configImports: [],
      });
    });

    it('should memoize per config file until it changes', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `export const config = { depRules: { noTag: 'noTag' } };`,
      );
      const configFile = toFsPath(getFs().cwd() + '/sheriff.config.ts');

      const first = parseConfig(configFile);
      expect(parseConfig(configFile)).toBe(first);

      getFs().writeFile(
        'sheriff.config.ts',
        `export const config = { depRules: { changed: 'changed' } };`,
      );

      const reparsed = parseConfig(configFile);
      expect(reparsed).not.toBe(first);
      expect(reparsed.depRules).toEqual({ changed: 'changed' });
    });

    it('should keep configured plugins', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
export const config = {
  depRules: {},
  entryFile: 'src/main.ts',
  plugins: [
    {
      name: 'junit',
      async execute() {},
    },
  ],
};
      `,
      );

      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );

      expect(config.plugins).toHaveLength(1);
      expect(config.plugins?.[0].name).toBe('junit');
      expect(typeof config.plugins?.[0].execute).toBe('function');
    });

    it('should throw if modules is missing and autoTagging is disabled', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  autoTagging: false,
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).toThrowUserError(new MissingModulesWithoutAutoTaggingError());
    });

    it('should not throw if modules is present and autoTagging is disabled', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  autoTagging: false,
  modules: {}
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).not.toThrowUserError(new MissingModulesWithoutAutoTaggingError());
    });

    it('should not throw if tagging is present and autoTagging is disabled', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  autoTagging: false,
  tagging: {}
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).not.toThrowUserError(new MissingModulesWithoutAutoTaggingError());
    });

    it('should not throw if modules is empty and autoTagging does not exist', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  modules: {}
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).not.toThrowUserError(new MissingModulesWithoutAutoTaggingError());
    });

    it('should throw if both tagging and modules are available', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  modules: {},
  tagging: {}
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).toThrowUserError(new TaggingAndModulesError());
    });

    describe('configImports', () => {
      it('should record the provenance of a config import', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import * as ts from 'typescript';

export const config = {
  depRules: {},
  log: !ts.version,
};
      `,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        const resolvedPath = require.resolve('typescript');
        expect(config.configImports).toEqual([
          {
            specifier: 'typescript',
            resolvedPath,
            // VirtualFs#realpath is the identity function
            realPath: resolvedPath,
          },
        ]);
      });

      it('should keep configImports empty for a config without runtime imports', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `export const config = { depRules: {} };`,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        expect(config.configImports).toEqual([]);
      });

      it('should not record type-only imports', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: {},
};
      `,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        expect(config.configImports).toEqual([]);
      });

      it('should rethrow the original error for an unresolvable import', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import { blueprint } from '@does-not/exist';

export const config = {
  depRules: blueprint,
};
      `,
        );

        let thrownError: unknown;
        try {
          parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts'));
        } catch (error) {
          thrownError = error;
        }

        expect(thrownError).toBeInstanceOf(Error);
        expect((thrownError as Error).message).toContain(
          "Cannot find module '@does-not/exist'",
        );
        expect((thrownError as NodeJS.ErrnoException).code).toBe(
          'MODULE_NOT_FOUND',
        );
      });

      it('should support require.resolve inside the config and record it', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
export const config = {
  depRules: {},
  log: !require.resolve('typescript'),
};
      `,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        const resolvedPath = require.resolve('typescript');
        expect(config.log).toBe(false);
        expect(config.configImports).toEqual([
          { specifier: 'typescript', resolvedPath, realPath: resolvedPath },
        ]);
      });

      it('should record each specifier only once', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import * as ts from 'typescript';

export const config = {
  depRules: {},
  log: !ts.version && !require.resolve('typescript'),
};
      `,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        const resolvedPath = require.resolve('typescript');
        expect(config.configImports).toEqual([
          { specifier: 'typescript', resolvedPath, realPath: resolvedPath },
        ]);
      });

      it('should not record Node builtins', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import * as path from 'path';
import * as nodeFs from 'node:fs';

export const config = {
  depRules: {},
  log: !path.join('a', 'b') || !nodeFs.constants,
};
      `,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        expect(config.configImports).toEqual([]);
      });

      it('should capture provenance up to a failing import', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import * as ts from 'typescript';

let optional: unknown;
try {
  optional = require('@does-not/exist');
} catch {
  optional = undefined;
}

export const config = {
  depRules: {},
  log: !ts.version && Boolean(optional),
};
      `,
        );

        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        const resolvedPath = require.resolve('typescript');
        expect(config.configImports).toEqual([
          { specifier: 'typescript', resolvedPath, realPath: resolvedPath },
          {
            specifier: '@does-not/exist',
            resolvedPath: '',
            realPath: '',
            error: expect.stringContaining(
              "Cannot find module '@does-not/exist'",
            ),
          },
        ]);
      });
    });
  });

  it('should map a tagging to modules', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  tagging: {'src/app': 'app'}
};
      `,
    );

    const config: Record<string, unknown> = parseConfig(
      toFsPath(getFs().cwd() + '/sheriff.config.ts'),
    );
    expect(config['tagging']).toBeUndefined();
    expect(config['modules']).toEqual({ 'src/app': 'app' });
  });

  it('should use encapsulatedFolderNameForBarrelLess for encapsulationPatternForBarrellLess', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: {
    'root': 'noTag',
    'noTag': 'noTag',
  },
  encapsulatedFolderNameForBarrelLess: '_private'
};
      `,
    );

    expect(
      parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts'))
        .encapsulationPattern,
    ).toBe('_private');
  });

  it('should throw if both encapsulatedFolderNameForBarrelLess and encapsulationPatternForBarrelLess exist', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: {
    'root': 'noTag',
    'noTag': 'noTag',
  },
  encapsulatedFolderNameForBarrelLess: 'internal',
  encapsulationPattern: 'internal'
};
      `,
    );

    expect(() =>
      parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
    ).toThrowUserError(new CollidingEncapsulationSettings());
  });

  it('should throw if both entryFile and entryPoints are set', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
        import { SheriffConfig } from '@lambda-solutions/sheriff-core';

        export const config: SheriffConfig = {
          depRules: {
            'root': 'noTag',
            'noTag': 'noTag',
          },
          entryFile: 'src/index.ts',
          entryPoints: {
            'holiday': 'apps/holiday/src/index.ts',
          }
        };
      `,
    );

    expect(() =>
      parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
    ).toThrowUserError(new CollidingEntrySettings());
  });

  it('should throw if entryPoints is an empty Record', () => {
    getFs().writeFile(
      'sheriff.config.ts',
      `
        import { SheriffConfig } from '@lambda-solutions/sheriff-core';

        export const config: SheriffConfig = {
          depRules: {
            'root': 'noTag',
            'noTag': 'noTag',
          },
          entryPoints: {}
        };
      `,
    );

    expect(() =>
      parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
    ).toThrowUserError(new NoEntryPointsFoundError());
  });

  describe('ignoreFileExtensions', () => {
    it('should ensure that all file extensions are lowercase', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  ignoreFileExtensions: ['JPG', 'PNG', 'Json'],
  depRules: { root: 'noTag', noTag: 'noTag' }
};
        `,
      );
      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );
      expect(config.ignoreFileExtensions).toEqual(['jpg', 'png', 'json']);
    });

    describe('ignoreFileExtensions', () => {
      it('should ensure that all file extensions are unique', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  ignoreFileExtensions: ['json', 'json', 'png', 'PNG'],
  depRules: { root: 'noTag', noTag: 'noTag' }
};
        `,
        );
        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );
        expect(config.ignoreFileExtensions).toEqual(['json', 'png']);
      });

      it('should ensure that ignoreFileExtensions as function receives defaults', () => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  ignoreFileExtensions: (defaults) => defaults.filter(ext => ext.startsWith('j')).concat('mdx'),
  depRules: { root: 'noTag', 'noTag': 'noTag' }
};
        `,
        );
        const config = parseConfig(
          toFsPath(getFs().cwd() + '/sheriff.config.ts'),
        );

        expect(config.ignoreFileExtensions).toEqual([
          'jpg',
          'jpeg',
          'json',
          'mdx',
        ]);
      });
    });

    it('should use defaults when ignoreFileExtensions is not provided', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' }
};
      `,
      );
      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );
      expect(config.ignoreFileExtensions).toEqual(
        defaultIgnoreFileExtensions.map((ext: string) => ext.toLowerCase()),
      );
    });
  });
});
