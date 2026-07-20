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
import { fileURLToPath } from 'node:url';
import { generateBenchProject } from './gen-bench.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const distRoot = join(repoRoot, 'dist');
const cliPath = join(distRoot, 'packages/core/src/bin/main.js');
const coreDist = join(distRoot, 'packages/core');
const baselinePath = join(repoRoot, 'tools/perf/baseline.json');
const compare = process.argv.includes('--compare');
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--compare');
const benchmarkSizes = [
  { label: '2.1k', domains: 100, modulesPerDomain: 3, filesPerModule: 6 },
  { label: '10.5k', domains: 500, modulesPerDomain: 3, filesPerModule: 6 },
];

try {
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArguments.join(', ')}`);
  }
  assertBuilt();
  ensureCoreResolutionShim();

  const results = benchmarkSizes.map((size) => {
    const project = generateBenchProject(
      join(repoRoot, 'tmp/perf', size.label),
      {
        domains: size.domains,
        modulesPerDomain: size.modulesPerDomain,
        filesPerModule: size.filesPerModule,
      },
    );
    const runsMs = Array.from({ length: 3 }, (_, run) => {
      process.stdout.write(
        `verify ${size.label} (${project.files} files), run ${run + 1}/3... `,
      );
      const elapsedMs = runVerify(project.root);
      console.log(`${elapsedMs.toFixed(2)} ms`);
      return elapsedMs;
    });

    return {
      label: size.label,
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

function runVerify(projectRoot) {
  const startedAt = performance.now();
  const child = spawnSync(
    process.execPath,
    [cliPath, 'verify', 'src/main.ts'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SHERIFF_CACHE_STATS: '0',
        SHERIFF_NO_CACHE: '0',
      },
    },
  );
  const elapsedMs = performance.now() - startedAt;

  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(
      `verify failed for ${projectRoot} (exit ${child.status}):\n${child.stderr || child.stdout}`,
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
