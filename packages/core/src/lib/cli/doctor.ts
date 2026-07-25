import { checkForBarrelPolicyViolation } from '../checks/check-for-barrel-policy-violation';
import { checkForMissingTsConfig } from '../checks/check-for-missing-tsconfig';
import {
  checkForUnenforcedEncapsulation,
  UnenforcedEncapsulationReason,
} from '../checks/check-for-unenforced-encapsulation';
import { NoAssignedTagError } from '../error/user-error';
import { toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { init, ProjectInfo } from '../main/init';
import { calcTagsForModule } from '../tags/calc-tags-for-module';
import { cli } from './cli';
import {
  DEFAULT_PROJECT_NAME,
  getEntriesFromCliOrConfig,
} from './internal/get-entries-from-cli-or-config';

/**
 * Options for the `sheriff doctor` command.
 */
export type DoctorOptions = {
  /** Emit a machine-readable JSON report instead of the human-readable one. */
  json?: boolean;
};

/** Check 1: a module whose tag calculation resolves to no tags. */
type NoTagModuleFinding = {
  project: string;
  /** Module path relative to the project root. */
  module: string;
};

/** Check 2: an encapsulation-pattern folder which is not enforced. */
type UnenforcedEncapsulationFinding = {
  project: string;
  /** Folder path relative to the project root. */
  folder: string;
  reason: UnenforcedEncapsulationReason;
};

/** Check 3: a barrel file inside a barrel-less module tree. */
type BarrelFileEntry = {
  project: string;
  /** Barrel file path relative to the project root. */
  barrelFile: string;
  policy: 'allow' | 'warn' | 'forbid';
  /** `'info'` at `barrelPolicy: 'allow'`, `'error'` at `'warn'`/`'forbid'`. */
  severity: 'info' | 'error';
  message: string;
};

/** Check 3: barrels which stay legal via `allowBarrelsIn`. */
type AllowedBarrelEntry = {
  project: string;
  count: number;
};

/** Check 4: an entry point whose `tsconfig.json` cannot be found. */
type MissingTsConfigFinding = {
  project: string;
  entryFile: string;
  reason: string;
};

type DoctorReport = {
  noTagModules: NoTagModuleFinding[];
  unenforcedEncapsulations: UnenforcedEncapsulationFinding[];
  barrelFiles: BarrelFileEntry[];
  allowedBarrels: AllowedBarrelEntry[];
  missingTsConfigs: MissingTsConfigFinding[];
  projectInfos: Map<string, ProjectInfo>;
};

/**
 * `sheriff doctor [main.ts]` — runs diagnostic checks against the class of
 * silent enforcement gaps where the configuration is correct but what is
 * enforced is not what the author thinks, and nothing turns red:
 *
 * 1. modules that resolve to no tags (`noTag`),
 * 2. folders matching the `encapsulationPattern` which are not enforced,
 * 3. barrel files inside barrel-less module trees,
 * 4. entry points whose `tsconfig.json` cannot be found.
 *
 * Exits with code 1 on findings of checks 1, 2, and 4, and on check-3
 * findings under `barrelPolicy: 'warn'` or `'forbid'`.
 *
 * Without a `sheriff.config.ts`, the config-dependent checks 1–3 are
 * skipped — there is no configuration whose enforcement could silently
 * diverge — and only check 4 runs.
 */
export function doctor(args: string[], options: DoctorOptions = {}) {
  const entries = getEntriesFromCliOrConfig(args[0], false);

  const report: DoctorReport = {
    noTagModules: [],
    unenforcedEncapsulations: [],
    barrelFiles: [],
    allowedBarrels: [],
    missingTsConfigs: [],
    projectInfos: new Map(),
  };

  for (const entry of entries) {
    runChecksForEntry(entry.projectName, entry.entryFile, report);
  }

  const exitCode = calcExitCode(report);

  if (options.json) {
    cli.log(JSON.stringify(toJsonReport(report, exitCode), null, '  '));
  } else {
    logHumanReport(
      entries.map((entry) => entry.projectName),
      report,
      exitCode,
    );
  }

  if (exitCode === 0) {
    cli.endProcessOk();
  } else {
    cli.endProcessError();
  }
}

function runChecksForEntry(
  project: string,
  entryFile: string,
  report: DoctorReport,
): void {
  const fs = getFs();

  // Check 4 — must run before `init`, which requires the tsconfig.
  const missingTsConfigReason = checkForMissingTsConfig(entryFile);
  if (missingTsConfigReason !== undefined) {
    report.missingTsConfigs.push({
      project,
      entryFile,
      reason: missingTsConfigReason,
    });
    return;
  }

  const absoluteEntryFile = fs.isAbsolute(entryFile)
    ? entryFile
    : fs.join(fs.cwd(), entryFile);
  const projectInfo = init(toFsPath(absoluteEntryFile));
  report.projectInfos.set(project, projectInfo);

  if (projectInfo.config.isConfigFileMissing) {
    // Checks 1–3 diagnose the configuration; without a config there is
    // nothing whose enforcement could silently diverge.
    return;
  }

  collectNoTagModules(project, projectInfo, report);
  collectUnenforcedEncapsulations(project, projectInfo, report);
  collectBarrelFiles(project, projectInfo, report);
}

/**
 * Check 1 — reuses the existing tag calculation: a module is reported when
 * its tags resolve to `['noTag']` (auto-tagging fallback) or to no tag at
 * all (`autoTagging: false` raises `NoAssignedTagError` lazily).
 */
function collectNoTagModules(
  project: string,
  projectInfo: ProjectInfo,
  report: DoctorReport,
): void {
  const fs = getFs();

  for (const module of projectInfo.modules) {
    if (module.isRoot) {
      continue;
    }

    let tags: string[];
    try {
      tags = calcTagsForModule(
        module.path,
        projectInfo.rootDir,
        projectInfo.config.modules,
        projectInfo.config.autoTagging,
      );
    } catch (error) {
      if (error instanceof NoAssignedTagError) {
        tags = [];
      } else {
        throw error;
      }
    }

    if (tags.length === 0 || (tags.length === 1 && tags[0] === 'noTag')) {
      report.noTagModules.push({
        project,
        module: fs.relativeTo(projectInfo.rootDir, module.path),
      });
    }
  }
}

/** Check 2 — see {@link checkForUnenforcedEncapsulation}. */
function collectUnenforcedEncapsulations(
  project: string,
  projectInfo: ProjectInfo,
  report: DoctorReport,
): void {
  const fs = getFs();

  for (const finding of checkForUnenforcedEncapsulation(projectInfo)) {
    report.unenforcedEncapsulations.push({
      project,
      folder: fs.relativeTo(projectInfo.rootDir, finding.folderPath),
      reason: finding.reason,
    });
  }
}

/**
 * Check 3 — reuses `checkForBarrelPolicyViolation`. At
 * `barrelPolicy: 'allow'` the check itself reports nothing, so doctor
 * re-runs it with a `'warn'` policy to enumerate the same barrels as
 * informational hints; at `'warn'`/`'forbid'` its violations are findings.
 * Barrels matched by `allowBarrelsIn` are never findings — only their
 * count is reported.
 */
function collectBarrelFiles(
  project: string,
  projectInfo: ProjectInfo,
  report: DoctorReport,
): void {
  const { config } = projectInfo;
  if (!config.enableBarrelLess) {
    return;
  }

  const fs = getFs();
  const policy = config.barrelPolicy;
  const violations =
    policy === 'allow'
      ? checkForBarrelPolicyViolation({
          ...projectInfo,
          config: { ...config, barrelPolicy: 'warn' },
        })
      : checkForBarrelPolicyViolation(projectInfo);

  const barrelModuleCount = projectInfo.modules.filter(
    // `kind` is the metadata view a diagnostic may read; `hasBarrel` is
    // private so that runtime exposure decisions stay inside `Module`.
    (module) => module.kind === 'barrel',
  ).length;
  const allowedCount = barrelModuleCount - violations.length;
  if (allowedCount > 0) {
    report.allowedBarrels.push({ project, count: allowedCount });
  }

  for (const violation of violations) {
    report.barrelFiles.push({
      project,
      barrelFile: fs.relativeTo(projectInfo.rootDir, violation.barrelFilePath),
      policy,
      severity: policy === 'allow' ? 'info' : 'error',
      message: violation.message,
    });
  }
}

function countBarrelPolicyViolations(report: DoctorReport): number {
  return report.barrelFiles.filter((entry) => entry.severity === 'error')
    .length;
}

function countTotalFindings(report: DoctorReport): number {
  return (
    report.noTagModules.length +
    report.unenforcedEncapsulations.length +
    countBarrelPolicyViolations(report) +
    report.missingTsConfigs.length
  );
}

function calcExitCode(report: DoctorReport): 0 | 1 {
  return countTotalFindings(report) > 0 ? 1 : 0;
}

/**
 * Builds the `--json` structure. Key order is stable by construction:
 * a findings summary, per-check arrays, and the exit code.
 */
function toJsonReport(report: DoctorReport, exitCode: 0 | 1) {
  return {
    findings: {
      noTagModules: report.noTagModules.length,
      unenforcedEncapsulations: report.unenforcedEncapsulations.length,
      barrelPolicyViolations: countBarrelPolicyViolations(report),
      missingTsConfigs: report.missingTsConfigs.length,
      total: countTotalFindings(report),
    },
    checks: {
      noTagModules: report.noTagModules,
      unenforcedEncapsulations: report.unenforcedEncapsulations,
      barrelFiles: report.barrelFiles,
      allowedBarrels: report.allowedBarrels,
      missingTsConfigs: report.missingTsConfigs,
    },
    exitCode,
  };
}

const UNENFORCED_REASON_TEXT: Record<UnenforcedEncapsulationReason, string> = {
  'module-has-barrel':
    'the module has a barrel file; the barrel alone controls exposure',
  'barrel-less-disabled': 'enableBarrelLess is disabled',
};

function logHumanReport(
  projects: string[],
  report: DoctorReport,
  exitCode: 0 | 1,
): void {
  cli.log('');
  cli.log(cli.bold('Doctor Report'));

  for (const project of projects) {
    cli.log('');
    if (project !== DEFAULT_PROJECT_NAME) {
      cli.log(cli.bold(`Project: ${project}`));
      cli.log('');
    }

    const missingTsConfigs = report.missingTsConfigs.filter(
      (finding) => finding.project === project,
    );
    if (missingTsConfigs.length > 0) {
      cli.log('Entry points without tsconfig.json:');
      for (const finding of missingTsConfigs) {
        cli.log(`  |-- ${finding.entryFile}: ${finding.reason}`);
      }
      continue;
    }

    // present for every project which passed check 4 (see runChecksForEntry)
    const projectInfo = report.projectInfos.get(project)!;
    if (projectInfo.config.isConfigFileMissing) {
      cli.log(
        'No sheriff.config.ts found; the configuration checks were skipped. Run "npx sheriff init" to create one.',
      );
    } else {
      logNoTagModules(project, report);
      logUnenforcedEncapsulations(project, report);
      logBarrelFiles(project, report, projectInfo);
    }
    cli.log('Entry points without tsconfig.json:');
    cli.log('  none');
  }

  cli.log('');
  if (exitCode === 0) {
    cli.log('\u001b[32mDoctor found no issues. Well done!\u001b[0m');
  } else {
    const total = countTotalFindings(report);
    cli.log(`Doctor found ${total} issue${total === 1 ? '' : 's'}.`);
  }
}

function logNoTagModules(project: string, report: DoctorReport): void {
  const findings = report.noTagModules.filter(
    (finding) => finding.project === project,
  );
  cli.log('Modules without tags:');
  if (findings.length === 0) {
    cli.log('  none');
  }
  for (const finding of findings) {
    cli.log(`  |-- ${finding.module}`);
  }
}

function logUnenforcedEncapsulations(
  project: string,
  report: DoctorReport,
): void {
  const findings = report.unenforcedEncapsulations.filter(
    (finding) => finding.project === project,
  );
  cli.log('Unenforced encapsulation folders:');
  if (findings.length === 0) {
    cli.log('  none');
  }
  for (const finding of findings) {
    cli.log(
      `  |-- ${finding.folder} (${UNENFORCED_REASON_TEXT[finding.reason]})`,
    );
  }
}

function logBarrelFiles(
  project: string,
  report: DoctorReport,
  projectInfo: ProjectInfo,
): void {
  if (!projectInfo.config.enableBarrelLess) {
    cli.log(
      'Barrel files in barrel-less modules: skipped (enableBarrelLess is disabled)',
    );
    return;
  }

  const policy = projectInfo.config.barrelPolicy;
  const barrels = report.barrelFiles.filter(
    (entry) => entry.project === project,
  );
  const allowed = report.allowedBarrels.find(
    (entry) => entry.project === project,
  );

  cli.log(`Barrel files in barrel-less modules (barrelPolicy: ${policy}):`);
  if (barrels.length === 0 && !allowed) {
    cli.log('  none');
  }
  for (const barrel of barrels) {
    const hint = barrel.severity === 'info' ? ' (hint)' : '';
    cli.log(`  |-- ${barrel.barrelFile}${hint}: ${barrel.message}`);
  }
  if (allowed) {
    cli.log(
      `  ${allowed.count} barrel file${allowed.count === 1 ? '' : 's'} allowed by allowBarrelsIn`,
    );
  }
}
