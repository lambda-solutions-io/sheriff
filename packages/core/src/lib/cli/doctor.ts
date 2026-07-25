import {
  checkForBarrelPolicyViolation,
  findBarrelCandidates,
} from '../checks/check-for-barrel-policy-violation';
import { checkForMissingTsConfig } from '../checks/check-for-missing-tsconfig';
import {
  checkForUnenforcedEncapsulation,
  UnenforcedEncapsulationReason,
} from '../checks/check-for-unenforced-encapsulation';
import { defaultConfig } from '../config/default-config';
import { findConfig } from '../config/find-config';
import { parseConfig, readUserConfig } from '../config/parse-config';
import { resolveConfigFilePath } from '../config/resolve-config-for-file';
import { UserSheriffConfig } from '../config/user-sheriff-config';
import { NoAssignedTagError } from '../error/user-error';
import { FsPath, toFsPath } from '../file-info/fs-path';
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

/**
 * Check 5: a workspace-shaping option which a sub-config silently inherits
 * from the defaults instead of from the root config.
 */
type SubConfigFallbackFinding = {
  /** Sub-config path relative to the project root. */
  subConfig: string;
  /** Workspace-relative directory which that sub-config governs. */
  directory: string;
  /** Name of the option which is not set in the sub-config. */
  option: string;
  /** The value the root config sets for it. */
  rootValue: string;
  /** The value which is in effect for `directory` — always the default. */
  effectiveValue: string;
};

type DoctorReport = {
  noTagModules: NoTagModuleFinding[];
  unenforcedEncapsulations: UnenforcedEncapsulationFinding[];
  barrelFiles: BarrelFileEntry[];
  allowedBarrels: AllowedBarrelEntry[];
  missingTsConfigs: MissingTsConfigFinding[];
  subConfigFallbacks: SubConfigFallbackFinding[];
  /** Root config files whose `configs` entries check 5 already visited. */
  checkedRootConfigs: Set<FsPath>;
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
 * 4. entry points whose `tsconfig.json` cannot be found,
 * 5. workspace-shaping options which a sub-config referenced via `configs`
 *    silently inherits from the defaults instead of from the root config.
 *
 * Exits with code 1 on findings of checks 1, 2, 4, and 5, and on check-3
 * findings under `barrelPolicy: 'warn'` or `'forbid'`.
 *
 * Without a `sheriff.config.ts`, the config-dependent checks 1–3 and 5 are
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
    subConfigFallbacks: [],
    checkedRootConfigs: new Set(),
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
    // Checks 1–3 and 5 diagnose the configuration; without a config there is
    // nothing whose enforcement could silently diverge.
    return;
  }

  collectNoTagModules(project, projectInfo, report);
  collectUnenforcedEncapsulations(project, projectInfo, report);
  collectBarrelFiles(project, projectInfo, report);
  collectSubConfigFallbacks(projectInfo, report);
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

  // every barrel the policy could report — barrel modules, plus (with
  // `moduleIdentity: 'config'`) barrels which create no module at all.
  const barrelCount = findBarrelCandidates(projectInfo).length;
  const allowedCount = barrelCount - violations.length;
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

/**
 * Options which shape the whole workspace rather than a single module, and
 * which therefore have to be repeated in every sub-config.
 */
const WORKSPACE_SHAPING_OPTIONS = [
  'enableBarrelLess',
  'moduleIdentity',
  'barrelPolicy',
  'allowBarrelsIn',
  'encapsulationPattern',
  'barrelFileName',
  'excludeRoot',
  'autoTagging',
] as const;

type WorkspaceShapingOption = (typeof WORKSPACE_SHAPING_OPTIONS)[number];

/**
 * Deprecated aliases through which an option can also be set. A sub-config
 * using the alias has made a deliberate choice and must stay silent.
 */
const OPTION_ALIASES: Partial<
  Record<WorkspaceShapingOption, keyof UserSheriffConfig>
> = {
  encapsulationPattern: 'encapsulatedFolderNameForBarrelLess',
};

/**
 * Check 5 — a sub-config referenced via `configs` is parsed standalone: it is
 * merged with the DEFAULTS, never with the root config. Every workspace-wide
 * option the root config sets therefore silently reverts to its default for
 * everything that sub-config governs, and no other check reports it.
 *
 * Reported is every option where the root config sets a non-default value and
 * the sub-config does not set the option at all. A sub-config which sets the
 * option explicitly — even to the very same value as the default — has made a
 * deliberate choice and stays silent.
 *
 * The finding is a property of the root config, not of an entry point, so it
 * is collected once per root config file: attributing it to a project would
 * multiply one configuration mistake by the number of entry points.
 */
function collectSubConfigFallbacks(
  projectInfo: ProjectInfo,
  report: DoctorReport,
): void {
  const fs = getFs();
  // present for every project which got here (see runChecksForEntry)
  const rootConfigFile = findConfig(projectInfo.rootDir)!;
  if (report.checkedRootConfigs.has(rootConfigFile)) {
    return;
  }
  report.checkedRootConfigs.add(rootConfigFile);

  const rootConfig = parseConfig(rootConfigFile);

  for (const [directory, configPath] of Object.entries(rootConfig.configs)) {
    const subConfigFile = resolveConfigFilePath(
      projectInfo.rootDir,
      directory,
      configPath,
    );
    const subUserConfig = readUserConfig(subConfigFile);

    for (const option of WORKSPACE_SHAPING_OPTIONS) {
      const rootValue = formatOptionValue(rootConfig[option]);
      const defaultValue = formatOptionValue(defaultConfig[option]);

      if (
        rootValue === defaultValue ||
        isExplicitlySet(subUserConfig, option)
      ) {
        continue;
      }

      report.subConfigFallbacks.push({
        subConfig: fs.relativeTo(projectInfo.rootDir, subConfigFile),
        directory,
        option,
        rootValue,
        effectiveValue: defaultValue,
      });
    }
  }
}

function isExplicitlySet(
  userConfig: UserSheriffConfig,
  option: WorkspaceShapingOption,
): boolean {
  const alias = OPTION_ALIASES[option];
  return (
    userConfig[option] !== undefined ||
    (alias !== undefined && userConfig[alias] !== undefined)
  );
}

/** Renders an option value so that it can be read back as written. */
function formatOptionValue(value: unknown): string {
  return value instanceof RegExp ? String(value) : JSON.stringify(value);
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
    report.missingTsConfigs.length +
    report.subConfigFallbacks.length
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
      subConfigFallbacks: report.subConfigFallbacks.length,
      total: countTotalFindings(report),
    },
    checks: {
      noTagModules: report.noTagModules,
      unenforcedEncapsulations: report.unenforcedEncapsulations,
      barrelFiles: report.barrelFiles,
      allowedBarrels: report.allowedBarrels,
      missingTsConfigs: report.missingTsConfigs,
      subConfigFallbacks: report.subConfigFallbacks,
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

  logSubConfigFallbacks(report);

  cli.log('');
  if (exitCode === 0) {
    cli.log('\u001b[32mDoctor found no issues. Well done!\u001b[0m');
  } else {
    const total = countTotalFindings(report);
    cli.log(`Doctor found ${total} issue${total === 1 ? '' : 's'}.`);
  }
}

/**
 * Check 5 is a property of the root config, not of a single entry point, so
 * it is logged once for the whole workspace instead of per project — and only
 * for workspaces which declare `configs` at all.
 */
function logSubConfigFallbacks(report: DoctorReport): void {
  const usesMultipleConfigs = [...report.projectInfos.values()].some(
    (projectInfo) => projectInfo.usesMultipleConfigs,
  );
  if (!usesMultipleConfigs) {
    return;
  }

  cli.log('');
  cli.log('Sub-configs falling back to defaults:');
  if (report.subConfigFallbacks.length === 0) {
    cli.log('  none');
    return;
  }

  cli.log(
    '  A sub-config is merged with the defaults, not with the root config. Repeat each option below in the sub-config.',
  );
  for (const finding of report.subConfigFallbacks) {
    cli.log(
      `  |-- ${finding.subConfig} (governs ${finding.directory}): ` +
        `${finding.option} is not set - the root config sets ${finding.rootValue}, ` +
        `so the default ${finding.effectiveValue} applies here`,
    );
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
