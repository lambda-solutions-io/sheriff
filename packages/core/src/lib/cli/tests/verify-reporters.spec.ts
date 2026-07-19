import { beforeEach, describe, expect, it, vitest } from 'vitest';
import { createProject } from '../../test/project-creator';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import getFs from '../../fs/getFs';
import { main } from '../main';
import { mockCli } from './helpers/mock-cli';

describe('verify reporters', () => {
  beforeEach(() => {
    vitest.restoreAllMocks();
  });

  it('should write json and junit reports', () => {
    mockCli();
    createProjectWithDependencyRuleViolation();

    main(
      'verify',
      'src/main.ts',
      '--format',
      'json,junit',
      '--output',
      'reports',
    );

    const jsonReport = readReport('reports/violations.json');
    const junitReport = readReport('reports/violations.xml');

    expect(JSON.parse(jsonReport)).toMatchObject({ hasError: true });
    expect(junitReport).toContain('<testsuites');
  });

  it('should overwrite reports on repeated verification runs', () => {
    mockCli();
    createProjectWithDependencyRuleViolation();

    main(
      'verify',
      'src/main.ts',
      '--format',
      'json',
      '--output',
      'reports',
    );
    main(
      'verify',
      'src/main.ts',
      '--format',
      'json',
      '--output',
      'reports',
    );

    const report = readReport('reports/violations.json');
    expect(JSON.parse(report)).toMatchObject({ hasError: true });
  });
});

function readReport(path: string): string {
  const fs = getFs();
  if (!fs.exists(path)) {
    throw new Error(`Expected report ${path} to exist`);
  }
  return fs.readFile(path);
}

function createProjectWithDependencyRuleViolation(): void {
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
}
