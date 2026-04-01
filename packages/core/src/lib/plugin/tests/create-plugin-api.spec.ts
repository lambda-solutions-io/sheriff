import { describe, expect, it } from 'vitest';
import { defaultIgnoreFileExtensions } from '../../config/default-file-extensions';
import { sheriffConfig } from '../../test/project-configurator';
import { createProject } from '../../test/project-creator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { mockCli } from '../../cli/tests/helpers/mock-cli';
import { createPluginAPI } from '../create-plugin-api';

const config = {
  version: 1 as const,
  autoTagging: true,
  modules: {},
  depRules: {},
  enableBarrelLess: false,
  encapsulationPattern: 'internal',
  excludeRoot: false,
  log: false,
  isConfigFileMissing: false,
  entryFile: 'src/main.ts',
  barrelFileName: 'index.ts',
  entryPoints: undefined,
  ignoreFileExtensions: defaultIgnoreFileExtensions,
  plugins: undefined,
};

describe('createPluginAPI', () => {
  it('should return a successful verification result for a clean project', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: {},
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': [],
      },
    });

    const api = createPluginAPI(config);
    const result = api.verify();

    expect(result).toEqual({
      success: true,
      encapsulationViolationCount: 0,
      dependencyRuleViolationCount: 0,
      filesWithViolationsCount: 0,
      violations: {},
    });
  });

  it('should report dependency rule violations', () => {
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
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': ['./holidays', './customers'],
        holidays: {
          'index.ts': ['./holidays.component'],
          'holidays.component.ts': ['../customers'],
        },
        customers: {
          'index.ts': [],
        },
      },
    });

    const api = createPluginAPI({
      ...config,
      modules: {
        'src/customers': ['customers'],
        'src/holidays': ['holidays'],
      },
      depRules: {
        root: ['customers', 'holidays'],
        customers: [],
        holidays: [],
      },
    });
    const result = api.verify();

    expect(result.success).toBe(false);
    expect(result.dependencyRuleViolationCount).toBe(1);
    expect(result.filesWithViolationsCount).toBe(1);
    expect(Object.keys(result.violations)).toEqual([
      'src/holidays/holidays.component.ts',
    ]);
  });

  it('should return project data', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: {},
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': ['./customers'],
        customers: {
          'index.ts': [],
        },
      },
    });

    const api = createPluginAPI(config);
    const projectData = api.getProjectData();

    expect(projectData['/project/src/main.ts']).toBeDefined();
    expect(projectData['/project/src/customers/index.ts']).toBeDefined();
  });

  it('should return project data with external libraries when requested', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: {},
        entryFile: 'src/main.ts',
      }),
      node_modules: {
        rxjs: {
          'index.js': '',
        },
      },
      src: {
        'main.ts': ['rxjs'],
      },
    });

    const api = createPluginAPI(config);
    const projectData = api.getProjectData(undefined, {
      includeExternalLibraries: true,
    });

    expect(projectData['/project/src/main.ts'].externalLibraries).toEqual([
      'rxjs',
    ]);
  });

  it('should return the parsed config', () => {
    createProject({
      'tsconfig.json': tsConfig(),
      'sheriff.config.ts': sheriffConfig({
        depRules: {},
        entryFile: 'src/main.ts',
      }),
      src: {
        'main.ts': [],
      },
    });

    const api = createPluginAPI(config);

    expect(api.getConfig()).toBe(config);
  });

  it('should log to stdout and stderr', () => {
    const { allErrorLogs, allLogs } = mockCli();
    const api = createPluginAPI(config);

    api.log('hello');
    api.logError('problem');

    expect(allLogs()).toBe('hello');
    expect(allErrorLogs()).toBe('problem');
  });
});
