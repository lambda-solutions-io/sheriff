import { beforeEach, describe, it, expect, beforeAll } from 'vitest';
import { VirtualFs } from '../../fs/virtual-fs';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { toFsPath } from '../../file-info/fs-path';
import { ProjectViolation } from '../project-violation';
import { JunitReporter } from '../internal/reporter/junit/junit-reporter';

describe('JUnit reporter', () => {
  let fs: VirtualFs;
  beforeAll(() => {
    useVirtualFs();
    fs = getFs() as VirtualFs;
  });

  beforeEach(() => {
    fs.reset();
    fs.createDir('/project/customers/feature');
    fs.createDir('/project/shared/master-data');
    fs.createDir('/project/customers/ui');
    fs.createDir('/project/app/shared/form');
  });
  it('should create a xml-file in /.sheriff/project/violations.xml', () => {
    const reporter = new JunitReporter({
      outputDir: '.sheriff',
      projectName: 'project',
    });
    const violations: ProjectViolation = {
      totalEncapsulationViolations: 0,
      totalViolatedFiles: 0,
      totalDependencyRuleViolations: 2,
      totalExternalRuleViolations: 0,
      hasError: true,
      violations: [
        {
          filePath: '/project/customers/feature/feature.ts',
          encapsulations: [],
          dependencyRules: [],
          externalRules: [],
          dependencyRuleViolations: [
            {
              rawImport: '@eternal/shared/master-data',
              fromModulePath: toFsPath('/project/customers/feature'),
              toModulePath: toFsPath('/project/shared/master-data'),
              fromTag: 'domain:customers',
              toTags: ['shared:master-data'],
            },
          ],
        },
        {
          filePath: '/project/customers/ui/ui.ts',
          encapsulations: [],
          dependencyRules: [],
          externalRules: [],
          dependencyRuleViolations: [
            {
              rawImport: '@eternal/shared/form',
              fromModulePath: toFsPath('/project/customers/ui'),
              toModulePath: toFsPath('/project/app/shared/form'),
              fromTag: 'domain:customers',
              toTags: ['shared:form'],
            },
          ],
        },
      ],
    };
    reporter.createReport(violations);

    expect(fs.readFile('.sheriff/project/violations.xml')).toMatchSnapshot();
  });

  it('should add external rule violations to the xml report', () => {
    const reporter = new JunitReporter({
      outputDir: '.sheriff',
      projectName: 'project',
    });
    const failureMessage =
      'external library foo is not allowed for tag domain:x';
    const violations: ProjectViolation = {
      totalEncapsulationViolations: 0,
      totalViolatedFiles: 1,
      totalDependencyRuleViolations: 0,
      totalExternalRuleViolations: 1,
      hasError: true,
      violations: [
        {
          filePath: '/project/customers/feature/feature.ts',
          encapsulations: [],
          dependencyRules: [],
          externalRules: [failureMessage],
          dependencyRuleViolations: [],
        },
      ],
    };

    reporter.createReport(violations);

    const report = fs.readFile('.sheriff/project/violations.xml');
    expect(report).toContain('name="external-rule"');
    expect(report).toContain(`failure message="${failureMessage}"`);
  });

  it('should escape XML special characters so the report stays well-formed', () => {
    const reporter = new JunitReporter({
      outputDir: '.sheriff',
      projectName: 'project',
    });
    const failureMessage = 'library <team> uses "R&D" & is not allowed';
    const violations: ProjectViolation = {
      totalEncapsulationViolations: 0,
      totalViolatedFiles: 1,
      totalDependencyRuleViolations: 1,
      totalExternalRuleViolations: 1,
      hasError: true,
      violations: [
        {
          filePath: '/project/customers/feature/feature.ts',
          encapsulations: [],
          dependencyRules: [],
          externalRules: [failureMessage],
          dependencyRuleViolations: [
            {
              rawImport: '@eternal/shared/a&b',
              fromModulePath: toFsPath('/project/customers/feature'),
              toModulePath: toFsPath('/project/shared/master-data'),
              fromTag: 'domain:R&D',
              toTags: ['shared:<master>'],
            },
          ],
        },
      ],
    };

    reporter.createReport(violations);

    const report = fs.readFile('.sheriff/project/violations.xml');

    // Escaped entities are present.
    expect(report).toContain('&amp;');
    expect(report).toContain('&lt;');
    expect(report).toContain('&gt;');
    expect(report).toContain('&quot;');
    expect(report).toContain('fromTag="domain:R&amp;D"');
    expect(report).toContain(
      'failure message="library &lt;team&gt; uses &quot;R&amp;D&quot; &amp; is not allowed"',
    );

    // No raw special chars leak into the XML (only the escaped forms remain).
    // Strip the well-formed entity references, then assert nothing raw is left.
    const withoutEntities = report.replace(
      /&(amp|lt|gt|quot|apos);/g,
      '',
    );
    expect(withoutEntities).not.toContain('&');
    // The raw source values must not appear unescaped.
    expect(report).not.toContain('domain:R&D');
    expect(report).not.toContain('<team>');
    expect(report).not.toContain('shared:<master>');
  });
});
