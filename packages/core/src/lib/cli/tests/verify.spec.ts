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

    it('keeps watch mode precedence and ignores the files option', () => {
      const verifySpy = vitest.spyOn(verifyFile, 'verify');
      const verifyWatchSpy = vitest
        .spyOn(verifyWatchFile, 'verifyWatch')
        .mockImplementation(() => undefined);

      main(
        'verify',
        'src/main.ts',
        '--files',
        'a.ts,b.ts',
        '--watch',
      );

      expect(verifyWatchSpy).toHaveBeenCalledWith(['src/main.ts']);
      expect(verifySpy).not.toHaveBeenCalled();
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
