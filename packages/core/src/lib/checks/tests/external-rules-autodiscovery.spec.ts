import { describe, expect, it } from 'vitest';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { toFsPath } from '../../file-info/fs-path';
import { ProjectInfo } from '../../main/init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { testInit } from '../../test/test-init';
import { checkForExternalRuleViolation } from '../check-for-external-rule-violation';

type PackageJson = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function createProjectInfo({
  bookingImports,
  packageJson,
  config = {},
  nodeModules = {},
}: {
  bookingImports: string[];
  packageJson?: PackageJson;
  config?: Partial<UserSheriffConfig>;
  nodeModules?: FileTree;
}): ProjectInfo {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      modules: { 'src/domain': ['type:x'] },
      depRules: { root: '*', '*': '*' },
      enableBarrelLess: true,
      ...config,
    } as UserSheriffConfig),
    ...(packageJson ? { 'package.json': JSON.stringify(packageJson) } : {}),
    ...(Object.keys(nodeModules).length > 0
      ? { node_modules: nodeModules }
      : {}),
    src: {
      'main.ts': ['./domain/booking.ts'],
      domain: {
        'booking.ts': bookingImports,
      },
    },
  });
}

function bookingFileInfo(projectInfo: ProjectInfo) {
  return projectInfo.getFileInfo(toFsPath('/project/src/domain/booking.ts'));
}

function violatedExternals(projectInfo: ProjectInfo) {
  return checkForExternalRuleViolation(
    toFsPath('/project/src/domain/booking.ts'),
    projectInfo,
  ).map((violation) => violation.externalLibrary);
}

describe('externalRules package.json autodiscovery', () => {
  it('should treat a declared but uninstalled bare package as external and report a violation', () => {
    const projectInfo = createProjectInfo({
      bookingImports: ['declared-lib'],
      packageJson: { dependencies: { 'declared-lib': '^1.0.0' } },
      config: { externalRules: { 'type:x': [] } },
    });

    expect(bookingFileInfo(projectInfo).getExternalLibraries()).toEqual([
      'declared-lib',
    ]);
    expect(bookingFileInfo(projectInfo).unresolvableImports).toEqual([]);
    expect(violatedExternals(projectInfo)).toEqual(['declared-lib']);
  });

  it('should leave an undeclared uninstalled bare package unresolvable', () => {
    const projectInfo = createProjectInfo({
      bookingImports: ['undeclared-lib'],
      packageJson: { dependencies: { other: '^1.0.0' } },
      config: { externalRules: { 'type:x': [] } },
    });

    expect(bookingFileInfo(projectInfo).getExternalLibraries()).toEqual([]);
    expect(bookingFileInfo(projectInfo).unresolvableImports).toEqual([
      'undeclared-lib',
    ]);
    expect(violatedExternals(projectInfo)).toEqual([]);
  });

  it('should keep a relative unresolvable import unresolvable even when a dependency has the same name', () => {
    const projectInfo = createProjectInfo({
      bookingImports: ['./declared-lib'],
      packageJson: { dependencies: { 'declared-lib': '^1.0.0' } },
      config: { externalRules: { 'type:x': [] } },
    });

    expect(bookingFileInfo(projectInfo).getExternalLibraries()).toEqual([]);
    expect(bookingFileInfo(projectInfo).unresolvableImports).toEqual([
      './declared-lib',
    ]);
    expect(violatedExternals(projectInfo)).toEqual([]);
  });

  it('should store the raw declared subpath import and allow it by wildcard', () => {
    const projectInfo = createProjectInfo({
      bookingImports: ['declared-lib/subpath'],
      packageJson: { peerDependencies: { 'declared-lib': '^1.0.0' } },
      config: { externalRules: { 'type:x': ['declared-lib/*'] } },
    });

    expect(bookingFileInfo(projectInfo).getExternalLibraries()).toEqual([
      'declared-lib/subpath',
    ]);
    expect(violatedExternals(projectInfo)).toEqual([]);
  });

  it('should keep resolvable node_modules imports external via the TypeScript resolver', () => {
    const projectInfo = createProjectInfo({
      bookingImports: ['installed-lib'],
      config: { externalRules: { 'type:x': [] } },
      nodeModules: {
        'installed-lib': {
          'index.ts': [],
        },
      },
    });

    expect(bookingFileInfo(projectInfo).getExternalLibraries()).toEqual([
      'installed-lib',
    ]);
    expect(violatedExternals(projectInfo)).toEqual(['installed-lib']);
  });

  it('should not report violations when externalRules are absent', () => {
    const projectInfo = createProjectInfo({
      bookingImports: ['declared-lib'],
      packageJson: { dependencies: { 'declared-lib': '^1.0.0' } },
    });

    expect(violatedExternals(projectInfo)).toEqual([]);
  });
});
