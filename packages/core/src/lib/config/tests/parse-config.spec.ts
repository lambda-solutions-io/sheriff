import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as ts from 'typescript';
import { parseConfig } from '../parse-config';
import { toFsPath } from '../../file-info/fs-path';
import getFs, { useVirtualFs } from '../../fs/getFs';
import {
  AllowBarrelsInWithoutBarrelPolicyError,
  BarrelPolicyWithoutBarrelLessError,
  CollidingEncapsulationSettings,
  CollidingEntrySettings,
  MissingModulesWithoutAutoTaggingError,
  ModuleIdentityConfigWithoutBarrelLessError,
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
      'barrelPolicy',
      'allowBarrelsIn',
      'moduleIdentity',
      'encapsulationPattern',
      'log',
      'entryFile',
      'isConfigFileMissing',
      'barrelFileName',
      'entryPoints',
      'ignoreFileExtensions',
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
        barrelPolicy: 'allow',
        allowBarrelsIn: [],
        moduleIdentity: 'auto',
        encapsulationPattern: 'internal',
        excludeRoot: false,
        log: false,
        isConfigFileMissing: false,
        entryFile: '',
        barrelFileName: 'index.ts',
        entryPoints: undefined,
        ignoreFileExtensions: defaultIgnoreFileExtensions,
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

  describe('barrelPolicy and allowBarrelsIn', () => {
    it.each(['warn', 'forbid'] as const)(
      'should throw if barrelPolicy is %s without enableBarrelLess',
      (barrelPolicy) => {
        getFs().writeFile(
          'sheriff.config.ts',
          `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  barrelPolicy: '${barrelPolicy}',
};
      `,
        );

        expect(() =>
          parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
        ).toThrowUserError(new BarrelPolicyWithoutBarrelLessError(barrelPolicy));
      },
    );

    it('should not throw if barrelPolicy is allow without enableBarrelLess', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  barrelPolicy: 'allow',
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).not.toThrow();
    });

    it('should throw if allowBarrelsIn is set without barrelPolicy', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  enableBarrelLess: true,
  allowBarrelsIn: ['**/api'],
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).toThrowUserError(new AllowBarrelsInWithoutBarrelPolicyError());
    });

    it('should throw if allowBarrelsIn is set with barrelPolicy allow', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  enableBarrelLess: true,
  barrelPolicy: 'allow',
  allowBarrelsIn: ['**/api'],
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).toThrowUserError(new AllowBarrelsInWithoutBarrelPolicyError());
    });

    it('should not throw if allowBarrelsIn is empty with barrelPolicy allow', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  allowBarrelsIn: [],
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).not.toThrow();
    });

    it('should pass a valid barrelPolicy configuration through', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  enableBarrelLess: true,
  barrelPolicy: 'forbid',
  allowBarrelsIn: ['**/api', 'libs/*/src/api'],
};
      `,
      );

      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );

      expect(config.barrelPolicy).toBe('forbid');
      expect(config.allowBarrelsIn).toEqual(['**/api', 'libs/*/src/api']);
    });

    it('should default barrelPolicy to allow and allowBarrelsIn to an empty array', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
};
      `,
      );

      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );

      expect(config.barrelPolicy).toBe('allow');
      expect(config.allowBarrelsIn).toEqual([]);
    });
  });

  describe('moduleIdentity', () => {
    it('should throw if moduleIdentity is config without enableBarrelLess', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  moduleIdentity: 'config',
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).toThrowUserError(new ModuleIdentityConfigWithoutBarrelLessError());
    });

    it('should throw if moduleIdentity is config with enableBarrelLess false', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  enableBarrelLess: false,
  moduleIdentity: 'config',
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).toThrowUserError(new ModuleIdentityConfigWithoutBarrelLessError());
    });

    it('should not throw if moduleIdentity is auto without enableBarrelLess', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  moduleIdentity: 'auto',
};
      `,
      );

      expect(() =>
        parseConfig(toFsPath(getFs().cwd() + '/sheriff.config.ts')),
      ).not.toThrow();
    });

    it('should pass a valid moduleIdentity configuration through', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
  enableBarrelLess: true,
  moduleIdentity: 'config',
};
      `,
      );

      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );

      expect(config.moduleIdentity).toBe('config');
    });

    it('should default moduleIdentity to auto', () => {
      getFs().writeFile(
        'sheriff.config.ts',
        `
import { SheriffConfig } from '@lambda-solutions/sheriff-core';

export const config: SheriffConfig = {
  depRules: { root: 'noTag', noTag: 'noTag' },
};
      `,
      );

      const config = parseConfig(
        toFsPath(getFs().cwd() + '/sheriff.config.ts'),
      );

      expect(config.moduleIdentity).toBe('auto');
    });
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
