import { beforeEach, describe, expect, it, vitest } from 'vitest';
import * as fileInfoGenerator from '../../file-info/generate-unassigned-file-info';
import { sheriffConfig } from '../../test/project-configurator';
import { createProject } from '../../test/project-creator';
import getFs from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { tsConfig } from '../../test/fixtures/ts-config';
import { violatesDependencyRule } from '../violates-dependency-rule';
import { violatesEncapsulationRule } from '../violates-encapsulation-rule';
import { clearSharedProjectInfo } from '../shared-project-info';
import { noDependencies, sameTag } from '@lambda-solutions/sheriff-core';

/**
 * ESLint runs every rule separately for the same file. These specs pin down
 * that the expensive `init()` happens once per file instead of once per
 * (file, rule) pair, without letting a stale result outlive its content.
 */
describe('shared project info across ESLint rules', () => {
  const entryFile = '/project/src/customers/feature/index.ts';

  const createTestProject = () =>
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/shared/<type>': ['shared'],
          'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
        },
        depRules: {
          root: ['type:feature'],
          'domain:*': sameTag,
          'type:feature': ['type:ui', 'shared'],
          'type:ui': noDependencies,
        },
      }),
      src: {
        'app.component.ts': ['./customers/feature'],
        customers: {
          feature: {
            'index.ts': ['../../shared/ui'],
          },
          ui: {
            'index.ts': [],
          },
        },
        shared: {
          ui: {
            'index.ts': ['./ui.component.ts'],
            'ui.component.ts': [],
          },
        },
      },
    });

  beforeEach(() => {
    clearSharedProjectInfo();
  });

  it('should parse the project once when two rules check the same file', () => {
    createTestProject();
    const fileContent = getFs().readFile(toFsPath(entryFile));
    const spy = vitest.spyOn(fileInfoGenerator, 'generateUnassignedFileInfo');

    violatesDependencyRule(entryFile, '../../shared/ui', true, fileContent);
    violatesEncapsulationRule(
      entryFile,
      '../../shared/ui',
      true,
      fileContent,
      true,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('should still report the violation to both rules from the shared result', () => {
    createTestProject();
    const fileContent = getFs().readFile(toFsPath(entryFile));

    const dependencyViolation = violatesDependencyRule(
      entryFile,
      '../../shared/ui',
      true,
      fileContent,
    );
    const encapsulationViolation = violatesEncapsulationRule(
      entryFile,
      '../../shared/ui',
      true,
      fileContent,
      true,
    );

    expect(dependencyViolation).toBe(
      'module /src/customers/feature cannot access /src/shared/ui. Tag domain:customers has no clearance for tags shared',
    );
    // reaching the barrel file is allowed, so encapsulation stays silent
    expect(encapsulationViolation).toBe('');
  });

  it('should re-parse when the file content changes', () => {
    createTestProject();
    const fileContent = getFs().readFile(toFsPath(entryFile));
    const spy = vitest.spyOn(fileInfoGenerator, 'generateUnassignedFileInfo');

    violatesDependencyRule(entryFile, '../../shared/ui', true, fileContent);
    violatesDependencyRule(
      entryFile,
      '../../shared/ui',
      true,
      `${fileContent}\nconst edited = 1;`,
    );

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
