import { beforeEach, describe, expect, it, vitest } from 'vitest';
import { tsConfig } from '../../test/fixtures/ts-config';
import { FileTree, sheriffConfig } from '../../test/project-configurator';
import { createProject } from '../../test/project-creator';
import * as getEntryFromCliOrConfigFile from '../internal/get-entries-from-cli-or-config';
import * as handleErrorFile from '../internal/handle-error';
import { BUILTIN_COMMANDS } from '../internal/builtin-commands';
import { main } from '../main';
import { mockCli } from './helpers/mock-cli';

function runDoctor(fileTree: FileTree, ...args: string[]) {
  const { allLogs, mockedCli } = mockCli();
  createProject(fileTree);
  main('doctor', ...args);
  return { allLogs, mockedCli };
}

const cleanProject: FileTree = {
  'tsconfig.json': tsConfig(),
  'sheriff.config.ts': sheriffConfig({
    modules: { 'src/customers': ['customers'] },
    depRules: { root: '*', customers: [] },
    enableBarrelLess: true,
  }),
  src: {
    'main.ts': ['./customers/api'],
    customers: { 'api.ts': [] },
  },
};

describe('doctor', () => {
  beforeEach(() => {
    vitest.restoreAllMocks();
  });

  describe('cli wiring', () => {
    it('should be a builtin command', () => {
      expect(BUILTIN_COMMANDS.has('doctor')).toBe(true);
    });

    it('should appear in the help', () => {
      const { allLogs } = mockCli();
      createProject(cleanProject);

      main();

      expect(allLogs()).toContain('sheriff doctor [main.ts]');
    });

    it('should call getEntriesFromCliOrConfig without init', () => {
      mockCli();
      createProject(cleanProject);
      const spy = vitest.spyOn(
        getEntryFromCliOrConfigFile,
        'getEntriesFromCliOrConfig',
      );

      main('doctor', 'src/main.ts');

      expect(spy).toHaveBeenCalledWith('src/main.ts', false);
    });

    it('should use the error handler', () => {
      mockCli();
      createProject(cleanProject);
      const spy = vitest.spyOn(handleErrorFile, 'handleError');

      main('doctor', 'src/main.ts');

      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe('check 1: modules without tags', () => {
    it('should report a module resolving to noTag', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: { 'src/customers': ['customers'] },
            depRules: { root: '*', customers: [] },
          }),
          src: {
            'main.ts': ['./customers', './holidays'],
            customers: { 'index.ts': [] },
            holidays: { 'index.ts': [] },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain('|-- src/holidays');
      expect(allLogs()).not.toContain('|-- src/customers');
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should report a module without an assigned tag when autoTagging is off', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            autoTagging: false,
            modules: { 'src/customers': ['customers'] },
            depRules: { root: '*', customers: [] },
          }),
          src: {
            'main.ts': ['./customers', './holidays'],
            customers: { 'index.ts': [] },
            holidays: { 'index.ts': [] },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain('|-- src/holidays');
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should rethrow tag calculation errors other than NoAssignedTagError', () => {
      const { allErrorLogs, mockedCli } = mockCli();
      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: { 'src/customers': ['domain:<nope>'] },
          depRules: { root: '*' },
        }),
        src: {
          'main.ts': ['./customers'],
          customers: { 'index.ts': [] },
        },
      });

      main('doctor', 'src/main.ts');

      expect(allErrorLogs()).toContain('cannot find a placeholder');
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should not report tagged modules', () => {
      const { allLogs, mockedCli } = runDoctor(cleanProject, 'src/main.ts');

      expect(allLogs()).toContain('Modules without tags:\n  none');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  describe('check 2: unenforced encapsulation folders', () => {
    it('should report a pattern folder when enableBarrelLess is disabled', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: {},
            depRules: {},
          }),
          src: {
            'main.ts': ['./customers/internal/secret'],
            customers: { internal: { 'secret.ts': [] } },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        '|-- src/customers/internal (enableBarrelLess is disabled)',
      );
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should report a pattern folder inside a barrel module', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: { 'src/customers': ['customers'] },
            depRules: { root: '*', customers: [] },
            enableBarrelLess: true,
          }),
          src: {
            'main.ts': ['./customers'],
            customers: {
              'index.ts': ['./internal/secret'],
              internal: { 'secret.ts': [] },
            },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        '|-- src/customers/internal (the module has a barrel file; the barrel alone controls exposure)',
      );
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should not report an enforced pattern folder in a barrel-less module', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: { 'src/customers': ['customers'] },
            depRules: { root: '*', customers: [] },
            enableBarrelLess: true,
          }),
          src: {
            'main.ts': ['./customers/api'],
            customers: {
              'api.ts': ['./internal/secret'],
              internal: { 'secret.ts': [] },
            },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain('Unenforced encapsulation folders:\n  none');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  // Complementarity with task 1 (any-depth encapsulation matching):
  // a nested pattern folder in a barrel-less module IS enforced, so
  // verify must report the deep import as an encapsulation violation
  // while doctor must NOT flag the folder as unenforced.
  describe('complementarity with any-depth encapsulation enforcement', () => {
    const nestedInternalProject: FileTree = {
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/customers': ['customers'] },
        depRules: { root: '*', customers: [] },
        enableBarrelLess: true,
      }),
      src: {
        // deep import from outside the module into the nested internal
        'main.ts': ['./customers/api', './customers/data/internal/secret'],
        customers: {
          'api.ts': ['./data/internal/secret'],
          data: { internal: { 'secret.ts': [] } },
        },
      },
    };

    it('should let verify report the nested pattern folder as enforced', () => {
      const { allLogs, mockedCli } = mockCli();
      createProject(nestedInternalProject);

      main('verify', 'src/main.ts');

      expect(allLogs()).toContain('Encapsulation Violations');
      expect(allLogs()).toContain('./customers/data/internal/secret');
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should not flag the nested pattern folder as unenforced', () => {
      const { allLogs, mockedCli } = runDoctor(
        nestedInternalProject,
        'src/main.ts',
      );

      expect(allLogs()).toContain('Unenforced encapsulation folders:\n  none');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  describe('check 3: barrel files in barrel-less module trees', () => {
    const strayBarrelProject = (
      barrelPolicy?: 'allow' | 'warn' | 'forbid',
      allowBarrelsIn?: string[],
    ): FileTree => ({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/customers': ['customers'] },
        depRules: { root: '*', customers: [] },
        enableBarrelLess: true,
        ...(barrelPolicy ? { barrelPolicy } : {}),
        ...(allowBarrelsIn ? { allowBarrelsIn } : {}),
      }),
      src: {
        'main.ts': ['./customers'],
        customers: { 'index.ts': [] },
      },
    });

    it('should print an informational hint at barrelPolicy allow', () => {
      const { allLogs, mockedCli } = runDoctor(
        strayBarrelProject(),
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        'Barrel files in barrel-less modules (barrelPolicy: allow):',
      );
      expect(allLogs()).toContain('|-- src/customers/index.ts (hint):');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('should report a finding at barrelPolicy warn', () => {
      const { allLogs, mockedCli } = runDoctor(
        strayBarrelProject('warn'),
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        'Barrel files in barrel-less modules (barrelPolicy: warn):',
      );
      expect(allLogs()).toContain('|-- src/customers/index.ts:');
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should report a finding at barrelPolicy forbid', () => {
      const { mockedCli } = runDoctor(
        strayBarrelProject('forbid'),
        'src/main.ts',
      );

      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should not report barrels matched by allowBarrelsIn', () => {
      const { allLogs, mockedCli } = runDoctor(
        strayBarrelProject('forbid', ['**/customers']),
        'src/main.ts',
      );

      expect(allLogs()).toContain('1 barrel file allowed by allowBarrelsIn');
      expect(allLogs()).not.toContain('|-- src/customers/index.ts');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('should report the count of multiple allowed barrels', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: {
              'src/customers': ['customers'],
              'src/holidays': ['holidays'],
            },
            depRules: { root: '*', customers: [], holidays: [] },
            enableBarrelLess: true,
            barrelPolicy: 'forbid',
            allowBarrelsIn: ['**'],
          }),
          src: {
            'main.ts': ['./customers', './holidays'],
            customers: { 'index.ts': [] },
            holidays: { 'index.ts': [] },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain('2 barrel files allowed by allowBarrelsIn');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('should skip the check without barrel-less mode', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: { 'src/customers': ['customers'] },
            depRules: { root: '*', customers: [] },
          }),
          src: {
            'main.ts': ['./customers'],
            customers: { 'index.ts': [] },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        'Barrel files in barrel-less modules: skipped (enableBarrelLess is disabled)',
      );
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  describe('check 4: entry points without tsconfig.json', () => {
    it('should report an entry point without a tsconfig.json', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'sheriff.config.ts': sheriffConfig({
            modules: {},
            depRules: {},
          }),
          src: {
            'main.ts': [],
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        '|-- src/main.ts: no tsconfig.json found above src/main.ts',
      );
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should report a missing entry file', () => {
      const { allLogs, mockedCli } = runDoctor({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {},
          depRules: {},
          entryPoints: { 'app-i': 'apps/app-i/src/main.ts' },
        }),
        src: {
          'main.ts': [],
        },
      });

      expect(allLogs()).toContain(
        '|-- apps/app-i/src/main.ts: entry file apps/app-i/src/main.ts does not exist',
      );
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should report no findings when the tsconfig.json is found', () => {
      const { allLogs, mockedCli } = runDoctor(cleanProject, 'src/main.ts');

      expect(allLogs()).toContain(
        'Entry points without tsconfig.json:\n  none',
      );
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  describe('projects without a sheriff.config.ts', () => {
    it('should skip the configuration checks and succeed', () => {
      const { allLogs, mockedCli } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          src: {
            'main.ts': ['./customers/internal/secret'],
            customers: { internal: { 'secret.ts': [] } },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain(
        'No sheriff.config.ts found; the configuration checks were skipped.',
      );
      expect(allLogs()).not.toContain('Modules without tags:');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  describe('multi-project setups', () => {
    it('should group the report by project', () => {
      const { allLogs, mockedCli } = runDoctor({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {},
          depRules: {},
          entryPoints: {
            'app-i': 'apps/app-i/main.ts',
            'app-ii': 'apps/app-ii/main.ts',
          },
        }),
        apps: {
          'app-i': { 'main.ts': [] },
          'app-ii': { 'main.ts': [] },
        },
      });

      expect(allLogs()).toContain('<b>Project: app-i</b>');
      expect(allLogs()).toContain('<b>Project: app-ii</b>');
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });

  describe('exit codes', () => {
    it('should exit successfully on a clean project', () => {
      const { mockedCli } = runDoctor(cleanProject, 'src/main.ts');

      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('should accept an absolute entry file path', () => {
      const { mockedCli } = runDoctor(cleanProject, '/project/src/main.ts');

      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('should print a green summary on a clean project', () => {
      const { allLogs } = runDoctor(cleanProject, 'src/main.ts');

      expect(allLogs()).toContain('Doctor found no issues. Well done!');
    });

    it('should print the finding count on failure', () => {
      const { allLogs } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: {},
            depRules: {},
          }),
          src: {
            'main.ts': ['./customers', './holidays'],
            customers: { 'index.ts': [] },
            holidays: { 'index.ts': [] },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain('Doctor found 2 issues.');
    });

    it('should use the singular for a single finding', () => {
      const { allLogs } = runDoctor(
        {
          'tsconfig.json': tsConfig(),
          'sheriff.config.ts': sheriffConfig({
            modules: {},
            depRules: {},
          }),
          src: {
            'main.ts': ['./customers'],
            customers: { 'index.ts': [] },
          },
        },
        'src/main.ts',
      );

      expect(allLogs()).toContain('Doctor found 1 issue.');
    });
  });

  describe('--json', () => {
    const findingsProject: FileTree = {
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: { 'src/customers': ['customers'] },
        depRules: { root: '*', customers: [] },
        enableBarrelLess: true,
        barrelPolicy: 'warn',
      }),
      src: {
        'main.ts': ['./customers', './holidays'],
        customers: {
          'index.ts': ['./internal/secret'],
          internal: { 'secret.ts': [] },
        },
        holidays: { 'index.ts': [] },
      },
    };

    it('should emit a machine-readable report', () => {
      const { allLogs, mockedCli } = runDoctor(
        findingsProject,
        'src/main.ts',
        '--json',
      );

      const report = JSON.parse(allLogs());
      expect(Object.keys(report)).toEqual(['findings', 'checks', 'exitCode']);
      expect(report.findings).toEqual({
        noTagModules: 1,
        unenforcedEncapsulations: 1,
        barrelPolicyViolations: 2,
        missingTsConfigs: 0,
        total: 4,
      });
      expect(report.exitCode).toBe(1);
      expect(mockedCli.endProcessError).toHaveBeenCalled();
    });

    it('should match the report snapshot', () => {
      const { allLogs } = runDoctor(findingsProject, 'src/main.ts', '--json');

      expect(allLogs()).toMatchSnapshot();
    });

    it('should emit exit code 0 for a clean project', () => {
      const { allLogs, mockedCli } = runDoctor(
        cleanProject,
        'src/main.ts',
        '--json',
      );

      const report = JSON.parse(allLogs());
      expect(report.exitCode).toBe(0);
      expect(report.findings.total).toBe(0);
      expect(Object.keys(report.checks)).toEqual([
        'noTagModules',
        'unenforcedEncapsulations',
        'barrelFiles',
        'allowedBarrels',
        'missingTsConfigs',
      ]);
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });
  });
});
