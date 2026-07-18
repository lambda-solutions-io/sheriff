import { describe, expect, it } from 'vitest';
import { createProject } from '../../test/project-creator';
import { toFsPath } from '../fs-path';
import {
  extractPackageName,
  getDependencyUniverse,
} from '../dependency-universe';
import getFs from '../../fs/getFs';

function writePackageJson(path: string, manifest: object) {
  getFs().writeFile(`${path}/package.json`, JSON.stringify(manifest));
}

function dependencyUniverse(fileDir: string, rootDir = '/project') {
  return getDependencyUniverse(toFsPath(fileDir), toFsPath(rootDir));
}

describe('dependency universe', () => {
  it('should include production, peer and optional dependencies', () => {
    createProject({
      package: { 'index.ts': [] },
      src: { 'main.ts': [] },
    });
    writePackageJson('/project', {
      dependencies: { react: '^18.0.0' },
      peerDependencies: { '@angular/core': '^18.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
      devDependencies: { vitest: '^3.0.0' },
    });

    expect([...dependencyUniverse('/project/src')].sort()).toEqual([
      '@angular/core',
      'fsevents',
      'react',
    ]);
  });

  it('should exclude devDependencies', () => {
    createProject({
      package: { 'index.ts': [] },
      src: { 'main.ts': [] },
    });
    writePackageJson('/project', {
      dependencies: { rxjs: '^7.0.0' },
      devDependencies: { '@types/node': '^22.0.0' },
    });

    expect(dependencyUniverse('/project/src')).toEqual(new Set(['rxjs']));
  });

  it('should let the nearest parent package.json win over the root manifest', () => {
    createProject({
      package: { 'index.ts': [] },
      packages: {
        feature: {
          src: { 'main.ts': [] },
        },
      },
    });
    writePackageJson('/project', {
      dependencies: { rootlib: '^1.0.0' },
    });
    writePackageJson('/project/packages/feature', {
      dependencies: { featurelib: '^1.0.0' },
    });

    expect(dependencyUniverse('/project/packages/feature/src')).toEqual(
      new Set(['featurelib']),
    );
  });

  it('should stop at rootDir and ignore manifests above it', () => {
    createProject({
      package: { 'index.ts': [] },
      workspace: {
        src: { 'main.ts': [] },
      },
    });
    writePackageJson('/project', {
      dependencies: { aboveRoot: '^1.0.0' },
    });

    expect(
      dependencyUniverse('/project/workspace/src', '/project/workspace'),
    ).toEqual(new Set());
  });

  it('should return an empty universe when no package.json exists', () => {
    createProject({
      package: { 'index.ts': [] },
      src: { 'main.ts': [] },
    });

    expect(dependencyUniverse('/project/src')).toEqual(new Set());
  });

  it('should silently skip an invalid package.json', () => {
    createProject({
      package: { 'index.ts': [] },
      src: { 'main.ts': [] },
    });
    getFs().writeFile('/project/package.json', '{invalid json');

    expect(dependencyUniverse('/project/src')).toEqual(new Set());
  });

  it('should re-read package.json when it changes', () => {
    createProject({
      package: { 'index.ts': [] },
      src: { 'main.ts': [] },
    });
    writePackageJson('/project', {
      dependencies: { before: '^1.0.0' },
    });

    expect(dependencyUniverse('/project/src')).toEqual(new Set(['before']));

    writePackageJson('/project', {
      dependencies: { after: '^1.0.0' },
    });

    expect(dependencyUniverse('/project/src')).toEqual(new Set(['after']));
  });
});

describe('extract package name', () => {
  it.each([
    ['react', 'react'],
    ['react/jsx-runtime', 'react'],
    ['@angular/core', '@angular/core'],
    ['@angular/core/testing', '@angular/core'],
    ['@scope/name/sub/path', '@scope/name'],
  ])('should extract %s as %s', (specifier, packageName) => {
    expect(extractPackageName(specifier)).toBe(packageName);
  });
});
