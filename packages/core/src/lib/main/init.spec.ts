import { createProject } from '../test/project-creator';
import { tsConfig } from '../test/fixtures/ts-config';
import { describe, expect, it } from 'vitest';
import { init } from './init';
import { toFsPath } from '../file-info/fs-path';
import { sheriffConfig } from '../test/project-configurator';
import { SheriffConfigNotFoundError } from '../error/user-error';
import '../test/expect.extensions';

describe('init', () => {
  it('should return config is no file present', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'main.ts': ['./customer'],
      customer: {
        'index.ts': [],
      },
    });

    const projectInfo = init(toFsPath('/project/main.ts'), { traverse: true });
    expect(projectInfo.config.isConfigFileMissing).toBe(true);
  });

  it('should have isConfigFileMissing as false if config file is present', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({ depRules: {} }),
      'main.ts': ['./customer'],
      customer: {
        'index.ts': [],
      },
    });

    const projectInfo = init(toFsPath('/project/main.ts'), { traverse: true });
    expect(projectInfo.config.isConfigFileMissing).toBe(false);
  });

  it('should return undefined when config file is missing and returnOnMissingConfig', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'main.ts': ['./customer'],
      customer: {
        'index.ts': [],
      },
    });

    const projectInfo = init(toFsPath('/project/main.ts'), {
      traverse: true,
      returnOnMissingConfig: true,
    });
    expect(projectInfo).toBeUndefined();
  });

  it('should throw a UserError when a selected configs file is missing', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        configs: {
          'apps/demo': './apps/demo/sheriff.config.ts',
        },
        depRules: {},
      }),
      apps: {
        demo: {
          src: {
            'main.ts': [],
          },
        },
      },
    });

    expect(() =>
      init(toFsPath('/project/apps/demo/src/main.ts'), { traverse: true }),
    ).toThrowUserError(
      new SheriffConfigNotFoundError(
        'apps/demo',
        './apps/demo/sheriff.config.ts',
      ),
    );
  });

  it('keeps cached module skeleton state isolated between linted files', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({ depRules: {} }),
      src: {
        feature: {
          'index.ts': [],
          'file-a.ts': ['./file-b'],
          'file-b.ts': [],
        },
      },
    });

    const fileA = toFsPath('/project/src/feature/file-a.ts');
    const fileB = toFsPath('/project/src/feature/file-b.ts');
    const featureModulePath = toFsPath('/project/src/feature');
    const lintOptions = {
      traverse: false,
      entryFileContent: 'export const value = 1;',
    };

    const firstFileAResult = init(fileA, lintOptions);
    const firstFileAModule = firstFileAResult.modules.find(
      ({ path }) => path === featureModulePath,
    );
    const firstFileASnapshot = snapshotModules(firstFileAResult);

    expect(firstFileAModule?.fileInfos.map(({ path }) => path)).toEqual([
      fileA,
    ]);

    const fileBResult = init(fileB, {
      traverse: false,
      entryFileContent: 'export const value = 2;',
    });
    const fileBModule = fileBResult.modules.find(
      ({ path }) => path === featureModulePath,
    );

    expect(fileBModule).not.toBe(firstFileAModule);
    expect(fileBModule?.fileInfos.map(({ path }) => path)).toEqual([fileB]);
    expect(snapshotModules(firstFileAResult)).toEqual(firstFileASnapshot);

    const secondFileAResult = init(fileA, lintOptions);
    expect(snapshotModules(secondFileAResult)).toEqual(firstFileASnapshot);
  });
});

function snapshotModules(projectInfo: ReturnType<typeof init>) {
  return projectInfo.modules.map(({ path, fileInfos }) => ({
    path,
    fileInfoPaths: fileInfos.map((fileInfo) => fileInfo.path),
  }));
}
