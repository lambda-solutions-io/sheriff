import { beforeEach, describe, expect, it, vitest } from 'vitest';
import { mockCli } from './helpers/mock-cli';
import {
  formatConfigImport,
  logConfigDetails,
} from '../internal/log-config-details';
import { ConfigImport } from '../../config/configuration';
import { ProjectInfo } from '../../main/init';
import { FsPath } from '../../file-info/fs-path';

function createProjectInfo(
  configFilePath: string | undefined,
  configImports: ConfigImport[] = [],
): ProjectInfo {
  return {
    rootDir: '/project' as FsPath,
    configFilePath: configFilePath as FsPath | undefined,
    config: { configImports },
  } as unknown as ProjectInfo;
}

describe('logConfigDetails', () => {
  beforeEach(() => {
    vitest.restoreAllMocks();
  });

  it('should log nothing without a config file', () => {
    const { allLogs } = mockCli();

    logConfigDetails(createProjectInfo(undefined));

    expect(allLogs()).toBe('');
  });

  it('should log only the config path without verbose', () => {
    const { allLogs } = mockCli();

    logConfigDetails(
      createProjectInfo('/project/sheriff.config.ts', [
        { specifier: 'pkg', resolvedPath: '/a', realPath: '/a' },
      ]),
    );

    expect(allLogs()).toBe('Config: sheriff.config.ts\n');
  });

  it('should log the config imports with verbose', () => {
    const { allLogs } = mockCli();

    logConfigDetails(
      createProjectInfo('/project/sheriff.config.ts', [
        { specifier: 'pkg', resolvedPath: '/a/index.js', realPath: '/a/index.js' },
      ]),
      true,
    );

    expect(allLogs()).toBe(
      [
        'Config: sheriff.config.ts',
        'Config imports:',
        '  pkg → /a/index.js',
        '',
      ].join('\n'),
    );
  });

  it('should mark an empty import list with verbose', () => {
    const { allLogs } = mockCli();

    logConfigDetails(createProjectInfo('/project/sheriff.config.ts'), true);

    expect(allLogs()).toBe(
      ['Config: sheriff.config.ts', 'Config imports:', '  (none)', ''].join(
        '\n',
      ),
    );
  });

  describe('formatConfigImport', () => {
    it('should format a resolved import', () => {
      expect(
        formatConfigImport({
          specifier: '@scope/pkg',
          resolvedPath: '/real/pkg/index.js',
          realPath: '/real/pkg/index.js',
        }),
      ).toBe('@scope/pkg → /real/pkg/index.js');
    });

    it('should mark a symlinked import', () => {
      expect(
        formatConfigImport({
          specifier: '@scope/pkg',
          resolvedPath: '/workspace/node_modules/@scope/pkg/index.js',
          realPath: '/workspace/packages/pkg/dist/index.js',
        }),
      ).toBe(
        '@scope/pkg → /workspace/packages/pkg/dist/index.js (symlinked from /workspace/node_modules/@scope/pkg/index.js)',
      );
    });

    it('should show the resolution error for a failed import', () => {
      expect(
        formatConfigImport({
          specifier: '@does-not/exist',
          resolvedPath: '',
          realPath: '',
          error: "Cannot find module '@does-not/exist'",
        }),
      ).toBe(
        "@does-not/exist → failed to resolve: Cannot find module '@does-not/exist'",
      );
    });
  });
});
