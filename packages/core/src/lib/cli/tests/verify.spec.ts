import { beforeEach, describe, expect, vitest, it } from 'vitest';
import { createProject } from '../../test/project-creator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { main } from '../main';
import { sheriffConfig } from '../../test/project-configurator';
import { verifyCliWrappers } from './verify-cli-wrapper';
import { mockCli } from './helpers/mock-cli';
import * as verifyFile from '../verify';
import * as verifyWatchFile from '../verify-watch';
import getFs from '../../fs/getFs';

describe('verify', () => {
  beforeEach(() => {
    vitest.restoreAllMocks();
  });

  verifyCliWrappers('verify', 'src/main.ts');

  it('should find no errors', () => {
    const { allLogs, allErrorLogs } = mockCli();

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [''],
      },
    });

    main('verify', 'src/main.ts');

    expect(allErrorLogs()).toMatchSnapshot('error');
    expect(allLogs()).toMatchSnapshot('log');
  });

  it('should find errors', () => {
    const { allLogs, allErrorLogs } = mockCli();

    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        modules: {
          'src/customers': ['customers'],
          'src/holidays': ['holidays'],
        },
        depRules: {
          root: ['customers', 'holidays'],
          customers: [],
          holidays: [],
        },
      }),
      src: {
        'main.ts': ['./holidays', './customers', './customers/data'],
        holidays: {
          'index.ts': ['./holidays.component'],
          'holidays.component.ts': ['../customers'],
        },
        customers: { 'index.ts': [], 'data.ts': [] },
      },
    });

    main('verify', 'src/main.ts');

    expect(allErrorLogs()).toMatchSnapshot('error.log');
    expect(allLogs()).toMatchSnapshot('logs.log');
  });

  it('should find errors without sheriff.config.ts', () => {
    const { allLogs, allErrorLogs } = mockCli();

    createProject({
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./holidays', './customers', './customers/data'],
        holidays: {
          'index.ts': ['./holidays.component'],
          'holidays.component.ts': ['../customers'],
        },
        customers: { 'index.ts': [], 'data.ts': [] },
      },
    });

    main('verify', 'src/main.ts');

    expect(allErrorLogs()).toMatchSnapshot('error.log');
    expect(allLogs()).toMatchSnapshot('logs.log');
  });

  describe('Multi project setup', () => {
    it('should find no errors when passing a single entryPoint', () => {
      const { allLogs, allErrorLogs } = mockCli();

      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          depRules: {},
          entryPoints: {
            'project-i': 'projects/project-i/src/main.ts',
            'project-ii': 'projects/project-ii/src/main.ts',
          },
        }),
        projects: {
          'project-i': {
            src: {
              'main.ts': [],
              'app.ts': [],
            },
          },
          'project-ii': {
            src: {
              'main.ts': [],
              'app.ts': [],
            },
          },
        },
      });

      main('verify', 'project-i');

      expect(allErrorLogs()).toMatchSnapshot('error');
      expect(allLogs()).toMatchSnapshot('log');
    });
    it('should find no errors when passing multiple entryPoints', () => {
      const { allLogs, allErrorLogs } = mockCli();

      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          depRules: {},
          entryPoints: {
            'project-i': 'projects/project-i/src/main.ts',
            'project-ii': 'projects/project-ii/src/main.ts',
          },
        }),
        projects: {
          'project-i': {
            src: {
              'main.ts': [],
              'app.ts': [],
            },
          },
          'project-ii': {
            src: {
              'main.ts': [],
              'app.ts': [],
            },
          },
        },
      });

      main('verify', 'project-i,project-ii');

      expect(allErrorLogs()).toMatchSnapshot('error');
      expect(allLogs()).toMatchSnapshot('log');
    });

    it('should find errors', () => {
      const { allLogs, allErrorLogs } = mockCli();

      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          entryPoints: {
            'project-i': 'projects/project-i/src/main.ts',
            'project-ii': 'projects/project-ii/src/main.ts',
          },
          modules: {
            'projects/project-i': {
              'src/customers': ['customers'],
              'src/holidays': ['holidays'],
            },
          },
          depRules: {
            root: ['customers', 'holidays'],
            customers: [],
            holidays: [],
          },
        }),
        projects: {
          'project-i': {
            src: {
              'main.ts': ['./holidays', './customers', './customers/data'],
              holidays: {
                'index.ts': ['./holidays.component'],
                'holidays.component.ts': ['../customers'],
              },
              customers: { 'index.ts': [], 'data.ts': [] },
            },
          },
          'project-ii': {
            src: {
              'main.ts': [],
              'app.ts': [],
            },
          },
        },
      });

      main('verify');

      expect(allErrorLogs()).toMatchSnapshot('error.log');
      expect(allLogs()).toMatchSnapshot('logs.log');
    });
  });

  describe('verify --files', () => {
    it('checks only the listed files', () => {
      const { allLogs, mockedCli } = mockCli();
      createProjectWithFileViolations();

      verifyFile.verify(['src/main.ts'], {
        files: ['src/holidays/holidays.component.ts'],
      });

      expect(allLogs()).toContain('|-- src/holidays/holidays.component.ts');
      expect(allLogs()).not.toContain('|-- src/orders/orders.component.ts');
      expect(mockedCli.endProcessError).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessOk).not.toHaveBeenCalled();
    });

    it('errors when a listed file exists on disk but is not in the project graph', () => {
      const { allLogs, mockedCli } = mockCli();

      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          entryFile: 'src/main.ts',
          depRules: {},
        }),
        src: {
          'main.ts': [],
          'orphan.ts': [],
        },
      });

      verifyFile.verify([], { files: ['src/orphan.ts'] });

      expect(allLogs()).toContain(
        'Error: src/orphan.ts exists on disk but is not part of the project graph.',
      );
      expect(mockedCli.endProcessError).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessOk).not.toHaveBeenCalled();
    });

    it('warns and skips a listed file that does not exist on disk', () => {
      const { allLogs, mockedCli } = mockCli();

      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          entryFile: 'src/main.ts',
          depRules: {},
        }),
        src: {
          'main.ts': [],
        },
      });

      verifyFile.verify([], { files: ['src/deleted.ts'] });

      expect(allLogs()).toContain(
        'Warning: src/deleted.ts does not exist; skipping.',
      );
      expect(mockedCli.endProcessOk).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('does not false-pass a violating file referenced via a non-canonical path', () => {
      const { allLogs, mockedCli } = mockCli();
      createProjectWithFileViolations();

      // The graph stores the file under its real path. Here we reference the
      // same violating file via an equivalent-but-different string (a
      // canonicalization-required path). realpath must map both sides to the
      // same identity so the file is matched and its violation is reported —
      // instead of being warned-and-skipped into a silent pass.
      const fs = getFs();
      const realpathSpy = vitest
        .spyOn(fs, 'realpath')
        .mockImplementation((p: string) =>
          p.replace('/symlinked/', '/project/'),
        );

      verifyFile.verify(['src/main.ts'], {
        files: ['/symlinked/src/orders/orders.component.ts'],
      });

      realpathSpy.mockRestore();

      expect(allLogs()).toContain('|-- src/orders/orders.component.ts');
      expect(allLogs()).not.toContain('is not part of the project graph');
      expect(mockedCli.endProcessError).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessOk).not.toHaveBeenCalled();
    });

    it('is a successful no-op when --files resolves to an empty list', () => {
      const { allLogs, mockedCli } = mockCli();
      createProjectWithFileViolations();

      verifyFile.verify(['src/main.ts'], { files: [] });

      expect(allLogs()).toContain('No files to verify.');
      expect(allLogs()).not.toContain('Verification Report');
      expect(mockedCli.endProcessOk).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('fails the process for a violation in a listed absolute path', () => {
      const { mockedCli } = mockCli();
      createProjectWithFileViolations();

      main(
        'verify',
        'src/main.ts',
        '--files',
        '/project/src/orders/orders.component.ts',
      );

      expect(mockedCli.endProcessError).toHaveBeenCalledOnce();
    });

    it('parses multiple file arguments', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', '--files', 'a.ts', 'b.ts');

      expect(verifySpy).toHaveBeenCalledWith([], {
        files: ['a.ts', 'b.ts'],
      });
    });

    it('parses comma separated file arguments', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', '--files', 'a.ts,b.ts');

      expect(verifySpy).toHaveBeenCalledWith([], {
        files: ['a.ts', 'b.ts'],
      });
    });

    it('parses space separated file arguments', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', '--files', 'a.ts b.ts');

      expect(verifySpy).toHaveBeenCalledWith([], {
        files: ['a.ts', 'b.ts'],
      });
    });

    it('parses the equals form --files=a,b', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', '--files=a.ts,b.ts');

      expect(verifySpy).toHaveBeenCalledWith([], {
        files: ['a.ts', 'b.ts'],
      });
    });

    it('keeps the entry file when it precedes --files', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', 'src/main.ts', '--files', 'bad.ts');

      expect(verifySpy).toHaveBeenCalledWith(['src/main.ts'], {
        files: ['bad.ts'],
      });
    });

    it('keeps the entry file with the equals form', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', 'src/main.ts', '--files=bad.ts');

      expect(verifySpy).toHaveBeenCalledWith(['src/main.ts'], {
        files: ['bad.ts'],
      });
    });

    it('passes an empty files list for a bare --files', () => {
      mockCli();
      const verifySpy = vitest
        .spyOn(verifyFile, 'verify')
        .mockImplementation(() => undefined);

      main('verify', 'src/main.ts', '--files');

      expect(verifySpy).toHaveBeenCalledWith(['src/main.ts'], {
        files: [],
      });
    });

    it('passes files through to watch mode', () => {
      const verifySpy = vitest.spyOn(verifyFile, 'verify');
      const verifyWatchSpy = vitest
        .spyOn(verifyWatchFile, 'verifyWatch')
        .mockImplementation(() => undefined);

      main('verify', 'src/main.ts', '--files', 'a.ts,b.ts', '--watch');

      expect(verifyWatchSpy).toHaveBeenCalledWith(['src/main.ts'], {
        files: ['a.ts', 'b.ts'],
      });
      expect(verifySpy).not.toHaveBeenCalled();
    });
  });

  describe('barrel policy', () => {
    function createBarrelPolicyProject(
      barrelPolicy: 'allow' | 'warn' | 'forbid',
      allowBarrelsIn?: string[],
    ): void {
      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/<domain>': ['domain:<domain>'],
            'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
          ...(barrelPolicy === 'allow' ? {} : { barrelPolicy }),
          ...(allowBarrelsIn ? { allowBarrelsIn } : {}),
        }),
        src: {
          'main.ts': ['./customers/feature/customers.component'],
          customers: {
            api: {
              'index.ts': ['./customers.port'],
              'customers.port.ts': [],
            },
            feature: {
              'customers.component.ts': ['../api'],
            },
            ui: {
              'customer.component.ts': [],
              'index.ts': [],
            },
          },
        },
      });
    }

    it('should fail with barrelPolicy forbid on stray barrels', () => {
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('forbid');

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessError).toHaveBeenCalled();
      expect(allLogs()).toContain('Total Barrel Policy Violations: 2');
      expect(allLogs()).toContain('|-- src/customers/api/index.ts');
      expect(allLogs()).toContain('|-- src/customers/ui/index.ts');
      expect(allLogs()).toContain(
        'index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
      );
    });

    it('should keep allowed barrels legal and flag the rest under forbid', () => {
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('forbid', ['**/api']);

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessError).toHaveBeenCalled();
      expect(allLogs()).toContain('Total Barrel Policy Violations: 1');
      expect(allLogs()).not.toContain('|-- src/customers/api/index.ts');
      expect(allLogs()).toContain('|-- src/customers/ui/index.ts');
    });

    it('should only warn with barrelPolicy warn', () => {
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('warn');

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(allLogs()).toContain(
        'Warning: src/customers/api/index.ts: index.ts turns a barrel-less module into a barrel module and changes its encapsulation semantics. Remove it or add the module to `allowBarrelsIn`.',
      );
      expect(allLogs()).toContain('Warning: src/customers/ui/index.ts:');
      expect(allLogs()).toContain('No issues found. 2 warnings.');
      expect(allLogs()).not.toContain('Well done!');
      expect(allLogs()).not.toContain('Total Barrel Policy Violations');
    });

    it('should use the singular for a single warning', () => {
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('warn', ['**/api']);

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(allLogs()).toContain('No issues found. 1 warning.');
    });

    it('should short-circuit to OK when --files resolves to zero files', () => {
      // `--files` with an empty list is a successful no-op which returns
      // before any check runs - including the barrel policy check.
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('forbid');

      verifyFile.verify(['src/main.ts'], { files: [] });

      expect(allLogs()).toContain('No files to verify.');
      expect(mockedCli.endProcessOk).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessError).not.toHaveBeenCalled();
    });

    it('should run the barrel policy check in --files mode', () => {
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('forbid');

      verifyFile.verify(['src/main.ts'], {
        files: ['src/customers/feature/customers.component.ts'],
      });

      expect(allLogs()).toContain('Total Barrel Policy Violations: 2');
      expect(mockedCli.endProcessError).toHaveBeenCalledOnce();
      expect(mockedCli.endProcessOk).not.toHaveBeenCalled();
    });

    it('should not double-count a barrel file which also has import violations', () => {
      const { allLogs, mockedCli } = mockCli();
      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/customers/<type>': ['type:<type>'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
          barrelPolicy: 'forbid',
        }),
        src: {
          'main.ts': ['./customers/ui'],
          customers: {
            api: {
              'index.ts': ['./customers.port'],
              'customers.port.ts': [],
            },
            ui: {
              // deep import into the api barrel module: an encapsulation
              // violation on the very file that also violates the policy
              'index.ts': ['../api/customers.port'],
            },
          },
        },
      });

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessError).toHaveBeenCalled();
      // ui/index.ts (encapsulation + policy) and api/index.ts (policy):
      // the shared entry must be counted once, not twice
      expect(allLogs()).toContain('Total Invalid Files: 2');
      expect(allLogs()).toContain('Total Encapsulation Violations: 1');
      expect(allLogs()).toContain('Total Barrel Policy Violations: 2');
    });

    it("should still report a barrel outside any module under moduleIdentity 'config'", () => {
      // the CI gate must not go blind on the case `moduleIdentity: 'config'`
      // exists to defuse: the barrel creates no module any more.
      const { allLogs, mockedCli } = mockCli();
      createProject({
        'tsconfig.json': tsConfig(),
        'sheriff.config.ts': sheriffConfig({
          modules: {
            'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
          },
          depRules: { '*': '*' },
          enableBarrelLess: true,
          moduleIdentity: 'config',
          barrelPolicy: 'forbid',
        }),
        src: {
          'main.ts': ['./customers/ui/customer.component'],
          customers: {
            'index.ts': [],
            ui: { 'customer.component.ts': [] },
          },
        },
      });

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessError).toHaveBeenCalled();
      expect(allLogs()).toContain('Total Barrel Policy Violations: 1');
      expect(allLogs()).toContain('|-- src/customers/index.ts');
      expect(allLogs()).toContain(
        "index.ts sits outside any module configured via `modules`. With moduleIdentity: 'config' it creates no module and has no effect on encapsulation. Remove it, add its directory to `modules`, or add it to `allowBarrelsIn`.",
      );
    });

    it('should not report stray barrels with the default policy', () => {
      const { allLogs, mockedCli } = mockCli();
      createBarrelPolicyProject('allow');

      main('verify', 'src/main.ts');

      expect(mockedCli.endProcessOk).toHaveBeenCalled();
      expect(allLogs()).not.toContain('Barrel Policy');
      expect(allLogs()).not.toContain('Warning:');
    });
  });
});

function createProjectWithFileViolations(): void {
  createProject({
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      modules: {
        'src/customers': ['customers'],
        'src/holidays': ['holidays'],
        'src/orders': ['orders'],
      },
      depRules: {
        root: ['customers', 'holidays', 'orders'],
        customers: [],
        holidays: [],
        orders: [],
      },
    }),
    src: {
      'main.ts': ['./holidays', './orders'],
      holidays: {
        'index.ts': ['./holidays.component'],
        'holidays.component.ts': ['../customers'],
      },
      orders: {
        'index.ts': ['./orders.component'],
        'orders.component.ts': ['../customers'],
      },
      customers: { 'index.ts': [] },
    },
  });
}
