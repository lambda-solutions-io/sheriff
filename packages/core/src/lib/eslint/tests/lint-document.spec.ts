import { describe, expect, it, vitest } from 'vitest';
import { anyTag } from '../../checks/any-tag';
import * as fileInfoGenerator from '../../file-info/generate-unassigned-file-info';
import { toFsPath } from '../../file-info/fs-path';
import getFs from '../../fs/getFs';
import { sheriffConfig } from '../../test/project-configurator';
import { createProject } from '../../test/project-creator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { lintDocument } from '../lint-document';
import { violatesDependencyRule } from '../violates-dependency-rule';
import { violatesEncapsulationRule } from '../violates-encapsulation-rule';

describe('lintDocument', () => {
  it('returns before document analysis when no Sheriff config exists', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./missing'],
      },
    });
    const analysisSpy = vitest.spyOn(
      fileInfoGenerator,
      'generateUnassignedFileInfo',
    );

    expect(lintDocument('/project/src/main.ts')).toEqual({
      configFileIsMissing: true,
      dependencyRuleViolations: [],
      encapsulationViolations: [],
      externalRuleViolations: [],
      unresolvableImports: [],
    });
    expect(analysisSpy).not.toHaveBeenCalled();
  });

  it('shares one project analysis between ESLint rules for the same file', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {},
        depRules: { '*': anyTag },
      }),
      src: {
        'main.ts': ['./customers/customer.component'],
        customers: {
          'index.ts': [],
          'customer.component.ts': [],
        },
      },
    });
    const filename = '/project/src/main.ts';
    const fileContent = getFs().readFile(toFsPath(filename));
    const analysisSpy = vitest.spyOn(
      fileInfoGenerator,
      'generateUnassignedFileInfo',
    );

    violatesDependencyRule(
      filename,
      './customers/customer.component',
      true,
      fileContent,
    );
    violatesEncapsulationRule(
      filename,
      './customers/customer.component',
      true,
      fileContent,
      false,
    );

    expect(analysisSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps supplied editor content separate from on-disk analysis', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {},
        depRules: { '*': anyTag },
      }),
      src: {
        'main.ts': ['./existing'],
        'existing.ts': [],
      },
    });
    const filename = '/project/src/main.ts';

    expect(
      lintDocument(filename, "import './missing';").unresolvableImports,
    ).toEqual(['./missing']);
    expect(lintDocument(filename).unresolvableImports).toEqual([]);
    expect(
      lintDocument(filename, "import './other-missing';").unresolvableImports,
    ).toEqual(['./other-missing']);
    expect(lintDocument(filename).unresolvableImports).toEqual([]);
  });

  it('matches the individual ESLint adapters for every violation family', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/shared/<type>': ['shared'],
          'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
        },
        depRules: {
          'domain:*': ['type:ui'],
          'type:feature': ['type:ui'],
        },
        externalRules: {
          'type:feature': [],
        },
      }),
      node_modules: {
        'forbidden-library': {
          'index.ts': [],
        },
      },
      src: {
        customers: {
          feature: {
            'index.ts': [
              '../../shared/ui',
              '../ui/ui.component',
              'forbidden-library',
              './missing',
            ],
          },
          ui: {
            'index.ts': [],
            'ui.component.ts': [],
          },
        },
        shared: {
          ui: {
            'index.ts': [],
          },
        },
      },
    });
    const filename = '/project/src/customers/feature/index.ts';
    const fileContent = getFs().readFile(toFsPath(filename));
    const result = lintDocument(filename, fileContent);

    expect(
      result.dependencyRuleViolations.some(
        ({ rawImport }) => rawImport === '../../shared/ui',
      ),
    ).toBe(true);
    expect(
      violatesDependencyRule(filename, '../../shared/ui', true, fileContent),
    ).not.toBe('');

    expect(
      result.externalRuleViolations.some(
        ({ externalLibrary }) => externalLibrary === 'forbidden-library',
      ),
    ).toBe(true);
    expect(
      violatesDependencyRule(filename, 'forbidden-library', false, fileContent),
    ).not.toBe('');

    expect(result.encapsulationViolations).toContain('../ui/ui.component');
    expect(
      violatesEncapsulationRule(
        filename,
        '../ui/ui.component',
        true,
        fileContent,
        false,
      ),
    ).not.toBe('');

    expect(result.unresolvableImports).toContain('./missing');
    expect(
      violatesDependencyRule(filename, './missing', false, fileContent),
    ).toBe('import ./missing cannot be resolved');
    expect(
      violatesEncapsulationRule(
        filename,
        './missing',
        false,
        fileContent,
        false,
      ),
    ).toBe('import ./missing cannot be resolved');
  });

  it('invalidates a document analysis when sheriff.config.ts changes', () => {
    const fs = createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/<domain>': ['domain:<domain>'],
        },
        depRules: {
          'domain:source': anyTag,
        },
      }),
      src: {
        source: {
          'index.ts': ['../target'],
        },
        target: {
          'index.ts': [],
        },
      },
    });
    const filename = '/project/src/source/index.ts';
    const fileContent = fs.readFile(toFsPath(filename));

    expect(lintDocument(filename, fileContent).dependencyRuleViolations).toEqual(
      [],
    );

    fs.writeFile(
      '/project/sheriff.config.ts',
      `export const config = {
        modules: { 'src/<domain>': ['domain:<domain>'] },
        depRules: { 'domain:source': [] }
      };`,
    );

    expect(
      lintDocument(filename, fileContent).dependencyRuleViolations,
    ).toEqual([
      {
        fromTag: 'domain:source',
        toTags: ['domain:target'],
        rawImport: '../target',
      },
    ]);
  });

  it('evicts old content revisions from the bounded analysis cache', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {},
        depRules: { '*': anyTag },
      }),
      src: {
        'main.ts': [],
      },
    });
    const filename = '/project/src/main.ts';
    const analysisSpy = vitest.spyOn(
      fileInfoGenerator,
      'generateUnassignedFileInfo',
    );
    const firstRevision = 'export const revision = 0;';

    lintDocument(filename, firstRevision);
    for (let revision = 1; revision <= 16; revision++) {
      lintDocument(filename, `export const revision = ${revision};`);
    }

    const analysesBeforeRevisit = analysisSpy.mock.calls.length;
    lintDocument(filename, firstRevision);

    expect(analysisSpy.mock.calls.length).toBeGreaterThan(
      analysesBeforeRevisit,
    );
  });

  it('rereads disk content even when the preceding call used the same path', () => {
    const fs = createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {},
        depRules: { '*': anyTag },
      }),
      src: {
        'main.ts': [],
      },
    });
    const filename = '/project/src/main.ts';
    const entryFile = toFsPath(filename);
    const readSpy = vitest.spyOn(fs, 'readFile');

    lintDocument(filename);
    const readsAfterFirstLint = readSpy.mock.calls.filter(
      ([path]) => path === entryFile,
    ).length;
    lintDocument(filename);
    const readsAfterSecondLint = readSpy.mock.calls.filter(
      ([path]) => path === entryFile,
    ).length;

    expect(readsAfterSecondLint).toBe(readsAfterFirstLint + 1);
  });

  it('returns defensive, serializable DTO copies', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
        },
        depRules: {
          'domain:source': [],
          'type:feature': [],
        },
        externalRules: {
          'type:feature': [],
        },
      }),
      node_modules: {
        restricted: {
          'index.ts': [],
        },
      },
      src: {
        source: {
          feature: {
            'index.ts': [
              '../../target/ui/internal',
              'restricted',
              './missing',
            ],
          },
        },
        target: {
          ui: {
            'index.ts': [],
            'internal.ts': [],
          },
        },
      },
    });
    const filename = '/project/src/source/feature/index.ts';
    const fileContent = getFs().readFile(toFsPath(filename));
    const result = lintDocument(filename, fileContent);
    const pristine = JSON.parse(JSON.stringify(result));

    expect(result).toEqual(pristine);
    expect(result.encapsulationViolations).toEqual([
      '../../target/ui/internal',
    ]);
    expect(result.dependencyRuleViolations[0]).toEqual({
      fromTag: 'domain:source',
      toTags: ['domain:target', 'type:ui'],
      rawImport: '../../target/ui/internal',
    });

    result.dependencyRuleViolations[0].toTags.length = 0;
    result.dependencyRuleViolations.length = 0;
    result.encapsulationViolations.length = 0;
    result.externalRuleViolations.length = 0;
    result.unresolvableImports.length = 0;

    expect(lintDocument(filename, fileContent)).toEqual(pristine);
  });
});
