import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateBenchProject } from './gen-bench.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const distRoot = join(repoRoot, 'dist');
const cliPath = join(distRoot, 'packages/core/src/bin/main.js');
const coreDist = join(distRoot, 'packages/core');
const baselinePath = join(repoRoot, 'tools/perf/baseline.json');
const eslintBinPath = join(repoRoot, 'node_modules/eslint/bin/eslint.js');
const tsParserPath = join(
  repoRoot,
  'node_modules/@typescript-eslint/parser/dist/index.js',
);
const compare = process.argv.includes('--compare');
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--compare');
const PROJECT_SHAPES = {
  '2.1k': { domains: 100, modulesPerDomain: 3, filesPerModule: 6 },
  '10.5k': { domains: 500, modulesPerDomain: 3, filesPerModule: 6 },
};

// Each scenario measures one command against one generated project shape.
// `project` keys into PROJECT_SHAPES; `generate` adds generator overrides
// that change the layout and therefore need a separate generated copy.
const benchmarkScenarios = [
  { label: '2.1k', project: '2.1k', kind: 'verify' },
  { label: '10.5k', project: '10.5k', kind: 'verify' },
  // Barrel-less exercises findExportsForModulePath, which the barrel
  // layout never reaches (issue #28).
  {
    label: 'barrel-less 2.1k',
    project: '2.1k',
    kind: 'verify',
    generate: { enableBarrelLess: true },
  },
  // `verify --files <one leaf>` should cost a fraction of a full verify
  // (issue #27); compare against the 10.5k full-verify row.
  { label: 'verify --files 10.5k', project: '10.5k', kind: 'verify-files' },
  // ESLint with both sheriff rules over the whole project (issue #25).
  { label: 'eslint 2.1k', project: '2.1k', kind: 'eslint' },
];

try {
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArguments.join(', ')}`);
  }
  assertBuilt();
  ensureCoreResolutionShim();

  const generatedProjects = new Map();
  const results = benchmarkScenarios.map((scenario) => {
    const project = generateOnce(generatedProjects, scenario);
    const runsMs = Array.from({ length: 3 }, (_, run) => {
      process.stdout.write(
        `${scenario.label} (${project.files} files), run ${run + 1}/3... `,
      );
      const elapsedMs = runScenario(scenario, project);
      console.log(`${elapsedMs.toFixed(2)} ms`);
      return elapsedMs;
    });

    return {
      label: scenario.label,
      files: project.files,
      medianMs: round(median(runsMs)),
      runsMs: runsMs.map(round),
    };
  });
  const current = {
    gitSha: gitSha(),
    node: process.version,
    sizes: Object.fromEntries(
      results.map(({ label, files, medianMs }) => [label, { files, medianMs }]),
    ),
  };

  if (compare) {
    compareWithBaseline(results);
  } else {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    printTable(results);
    console.log(`Baseline written to ${baselinePath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function assertBuilt() {
  const requiredFiles = [
    cliPath,
    join(coreDist, 'src/index.js'),
    join(coreDist, 'package.json'),
  ];
  const missingFiles = requiredFiles.filter((path) => !existsSync(path));
  if (missingFiles.length > 0) {
    throw new Error(
      `Sheriff's built dist is missing (${missingFiles.join(', ')}). Run "yarn build:all" before the benchmark.`,
    );
  }
}

function ensureCoreResolutionShim() {
  const namespaceDirectory = join(distRoot, 'node_modules/@lambda-solutions');
  const shimPath = join(namespaceDirectory, 'sheriff-core');
  mkdirSync(namespaceDirectory, { recursive: true });

  try {
    const stat = lstatSync(shimPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Cannot create core resolution shim because ${shimPath} already exists and is not a symlink.`,
      );
    }

    const currentTarget = resolve(namespaceDirectory, readlinkSync(shimPath));
    if (currentTarget !== coreDist) {
      throw new Error(
        `Core resolution shim points to ${currentTarget}; expected ${coreDist}.`,
      );
    }
    return;
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error;
    }
  }

  symlinkSync(relative(namespaceDirectory, coreDist), shimPath, 'dir');
}

/**
 * Generates each distinct project layout once and reuses it across the
 * scenarios that share it, so adding a scenario adds no generation cost.
 */
function generateOnce(cache, scenario) {
  const overrides = scenario.generate ?? {};
  const key = `${scenario.project}\0${JSON.stringify(overrides)}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const hasOverrides = Object.keys(overrides).length > 0;
  const directoryName = hasOverrides
    ? `${scenario.project}-${scenario.label.replace(/[^a-z0-9]+/gi, '-')}`
    : scenario.project;
  const project = generateBenchProject(
    join(repoRoot, 'tmp/perf', directoryName),
    { ...PROJECT_SHAPES[scenario.project], ...overrides },
  );
  cache.set(key, project);
  return project;
}

function runScenario(scenario, project) {
  switch (scenario.kind) {
    case 'verify':
      return runCli(project.root, ['verify', 'src/main.ts']);
    case 'verify-files':
      return runCli(project.root, [
        'verify',
        'src/main.ts',
        '--files',
        leafFileOf(project),
      ]);
    case 'eslint':
      return runEslint(project);
    default:
      throw new Error(`Unknown scenario kind: ${scenario.kind}`);
  }
}

/**
 * A single deep leaf file: the incremental `--files` path should cost a
 * fraction of a full verify on the same project.
 */
function leafFileOf(project) {
  const type = project.modulesPerDomain > 1 ? 'data' : 'feature';
  return `src/app/domain-${project.domains - 1}/${type}/file-0.ts`;
}

/** Lints the whole generated project with both sheriff rules. */
function runEslint(project) {
  writeFileSync(
    join(project.root, 'eslint.bench.config.mjs'),
    `import tsParser from '${pathToFileURL(tsParserPath).href}';
import sheriff from '${pathToFileURL(join(distRoot, 'packages/eslint-plugin/src/index.js')).href}';

export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@softarc/sheriff': sheriff },
    rules: {
      '@softarc/sheriff/dependency-rule': 'error',
      '@softarc/sheriff/encapsulation': 'error',
    },
  },
];
`,
  );

  return runProcess(
    eslintBinPath,
    ['--no-config-lookup', '--config', 'eslint.bench.config.mjs', 'src'],
    project.root,
    // ESLint exits 1 when it reports lint errors; only a crash is fatal
    // here, since the benchmark measures time, not cleanliness.
    (status) => status === 0 || status === 1,
  );
}

function runCli(projectRoot, args) {
  return runProcess(cliPath, args, projectRoot, (status) => status === 0);
}

function runProcess(binPath, args, cwd, isAcceptableStatus) {
  const startedAt = performance.now();
  const child = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      SHERIFF_CACHE_STATS: '0',
      SHERIFF_NO_CACHE: '0',
    },
  });
  const elapsedMs = performance.now() - startedAt;

  if (child.error) {
    throw child.error;
  }
  if (!isAcceptableStatus(child.status)) {
    throw new Error(
      `${args.join(' ')} failed in ${cwd} (exit ${child.status}):\n${child.stderr || child.stdout}`,
    );
  }
  return elapsedMs;
}

function compareWithBaseline(results) {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `No baseline found at ${baselinePath}. Run "yarn perf:bench" to create it.`,
    );
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  let hasRegression = false;
  const rows = results.map((result) => {
    const expected = baseline.sizes?.[result.label];
    if (!expected || expected.files !== result.files) {
      throw new Error(
        `Baseline size ${result.label} is missing or does not describe ${result.files} files.`,
      );
    }

    const changePercent =
      ((result.medianMs - expected.medianMs) / expected.medianMs) * 100;
    if (changePercent > 25) {
      hasRegression = true;
    }
    return {
      ...result,
      baselineMs: expected.medianMs,
      changePercent: round(changePercent),
    };
  });

  printTable(rows);
  console.log(`Compared with ${baseline.gitSha} on ${baseline.node}.`);
  if (hasRegression) {
    throw new Error(
      'Performance regression: a median exceeded its baseline by more than 25%.',
    );
  }
}

function printTable(results) {
  console.table(
    results.map((result) => ({
      size: result.label,
      files: result.files,
      runsMs: result.runsMs.join(', '),
      medianMs: result.medianMs,
      ...(result.baselineMs === undefined
        ? {}
        : {
            baselineMs: result.baselineMs,
            change: `${result.changePercent >= 0 ? '+' : ''}${result.changePercent}%`,
          }),
    })),
  );
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Could not read git SHA: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
