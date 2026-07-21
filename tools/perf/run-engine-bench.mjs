import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { generateBenchProject } from './gen-bench.mjs';

const require = createRequire(import.meta.url);
const {
  nativeBinaryName,
} = require('../../packages/sheriff-engine/platform.js');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const distRoot = join(repoRoot, 'dist');
const cliPath = join(distRoot, 'packages/core/src/bin/main.js');
const coreDist = join(distRoot, 'packages/core');
const engineSource = join(repoRoot, 'packages/sheriff-engine');
const resultsPath = join(repoRoot, 'tools/perf/r5-engine-results.json');
const fallbackMarker = '[sheriff-engine] Falling back to TypeScript:';
const runsPerMode = 3;
const benchmarkSizes = [
  { label: '2.1k', domains: 100, modulesPerDomain: 3, filesPerModule: 6 },
  { label: '10.5k', domains: 500, modulesPerDomain: 3, filesPerModule: 6 },
];
const realProjects = [
  {
    fixture: 'nextjs-i',
    project: 'default',
    root: join(repoRoot, 'test-projects/nextjs-i'),
    entry: 'shared/ui/index.ts',
    sourceFiles: 10,
  },
  {
    fixture: 'angular-v-multi',
    project: 'app-i',
    root: join(repoRoot, 'test-projects/angular-v-multi'),
    entry: 'app-i',
    sourceFiles: 15,
  },
  {
    fixture: 'angular-v-multi',
    project: 'app-ii',
    root: join(repoRoot, 'test-projects/angular-v-multi'),
    entry: 'app-ii',
    sourceFiles: 15,
  },
];

try {
  if (process.argv.length > 2) {
    throw new Error(`Unknown argument(s): ${process.argv.slice(2).join(', ')}`);
  }

  assertBuilt();
  ensureCoreResolutionShim();
  ensureEngineResolutionShim();

  const fixtureResults = confirmRealProjectFallbackRate();
  const benchmarkResults = benchmarkSizes.map(runSizeBenchmark);
  const results = createResults(benchmarkResults, fixtureResults);

  printBenchmarkTable(benchmarkResults);
  printFallbackSummary(results);
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Results written to ${resultsPath}`);
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
      `Sheriff's built dist is missing (${missingFiles.join(', ')}). Run "npx nx build core" before the benchmark.`,
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

// The engine is a workspace package that nx does not build into dist/ (ground
// rule #2), and it is not npm-installed in this dev tree. A published consumer
// gets it via core's optionalDependency; here we make it resolvable from the
// compiled CLI by symlinking the source package (which carries index.js,
// native/binding.js, and the built native artefact) into dist/node_modules.
// Without this the compiled CLI falls back to TypeScript on every project and
// the benchmark would measure TS while claiming to measure Rust.
function ensureEngineResolutionShim() {
  const nativeArtefact = join(engineSource, 'native', nativeBinaryName());
  if (!existsSync(nativeArtefact)) {
    throw new Error(
      `The native engine artefact is missing (${nativeArtefact}). Run ` +
        '"node packages/sheriff-engine/scripts/build-native.mjs" before the benchmark.',
    );
  }

  const namespaceDirectory = join(distRoot, 'node_modules/@lambda-solutions');
  const shimPath = join(namespaceDirectory, 'sheriff-engine');
  mkdirSync(namespaceDirectory, { recursive: true });

  try {
    const stat = lstatSync(shimPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Cannot create engine resolution shim because ${shimPath} already exists and is not a symlink.`,
      );
    }

    const currentTarget = resolve(namespaceDirectory, readlinkSync(shimPath));
    if (currentTarget !== resolve(engineSource)) {
      throw new Error(
        `Engine resolution shim points to ${currentTarget}; expected ${resolve(engineSource)}.`,
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

  symlinkSync(relative(namespaceDirectory, engineSource), shimPath, 'dir');
}

function confirmRealProjectFallbackRate() {
  console.log('Real-project engine fallback confirmation');
  return realProjects.map((project) => {
    process.stdout.write(
      `verify ${project.fixture}/${project.project} (${project.sourceFiles} source files)... `,
    );
    const run = runVerify(project.root, project.entry, 'engine');
    assertNoFallback(project.fixture + '/' + project.project, run, {
      projects: 1,
      files: project.sourceFiles,
    });
    assertSuccessful(run, project.root);
    console.log('fallback 0/1 projects (0%); 0 source files (0%)');
    return {
      fixture: project.fixture,
      project: project.project,
      entry: project.entry,
      sourceFiles: project.sourceFiles,
      fallbackMarkers: 0,
      projectsFellBack: 0,
      filesFellBack: 0,
      reasons: [],
    };
  });
}

function runSizeBenchmark(size) {
  const project = generateBenchProject(join(repoRoot, 'tmp/perf', size.label), {
    domains: size.domains,
    modulesPerDomain: size.modulesPerDomain,
    filesPerModule: size.filesPerModule,
  });
  const typescriptRunsMs = runMode(project, size.label, 'typescript');
  const engineRunsMs = runMode(project, size.label, 'engine');
  const typescriptMedianMs = round(median(typescriptRunsMs));
  const engineMedianMs = round(median(engineRunsMs));

  return {
    size: size.label,
    files: project.files,
    typescript: {
      runsMs: typescriptRunsMs.map(round),
      medianMs: typescriptMedianMs,
    },
    engine: {
      runsMs: engineRunsMs.map(round),
      medianMs: engineMedianMs,
    },
    speedup: round(typescriptMedianMs / engineMedianMs),
    fallback: {
      fallbackMarkers: 0,
      projectAttempts: runsPerMode,
      projectsFellBack: 0,
      projectRate: 0,
      fileAttempts: project.files * runsPerMode,
      filesFellBack: 0,
      fileRate: 0,
      reasons: [],
    },
  };
}

function runMode(project, label, mode) {
  return Array.from({ length: runsPerMode }, (_, runIndex) => {
    process.stdout.write(
      `verify ${label} (${project.files} files), ${mode}, run ${runIndex + 1}/${runsPerMode}... `,
    );
    const run = runVerify(project.root, 'src/main.ts', mode);
    if (mode === 'engine') {
      assertNoFallback(`${label} engine run ${runIndex + 1}`, run, {
        projects: 1,
        files: project.files,
      });
    }
    assertSuccessful(run, project.root);
    console.log(`${run.elapsedMs.toFixed(2)} ms`);
    return run.elapsedMs;
  });
}

function runVerify(projectRoot, entry, mode) {
  const env = {
    ...process.env,
    SHERIFF_CACHE_STATS: '0',
    SHERIFF_NO_CACHE: '0',
  };
  delete env.SHERIFF_ENGINE;
  delete env.SHERIFF_ENGINE_DEBUG;
  if (mode === 'engine') {
    env.SHERIFF_ENGINE = '1';
    env.SHERIFF_ENGINE_DEBUG = '1';
  }

  const startedAt = performance.now();
  const child = spawnSync(process.execPath, [cliPath, 'verify', entry], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
  });
  const elapsedMs = performance.now() - startedAt;
  const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
  const fallbackLines = output
    .split(/\r?\n/)
    .filter((line) => line.includes(fallbackMarker));

  return { ...child, elapsedMs, fallbackLines };
}

function assertNoFallback(scope, run, attempted) {
  if (run.fallbackLines.length === 0) {
    return;
  }

  const reasons = run.fallbackLines.map((line) =>
    line.slice(line.indexOf(fallbackMarker) + fallbackMarker.length).trim(),
  );
  const projectFallbacks = 1;
  const fileFallbacks = attempted.files;
  throw new Error(
    [
      `ENGINE FALLBACK DETECTED in ${scope}. Refusing to report this run as a Rust benchmark.`,
      'Fallback reason(s):',
      ...reasons.map((reason) => `- ${reason}`),
      `Fallback markers: ${run.fallbackLines.length}`,
      `Fallback rate: ${projectFallbacks}/${attempted.projects} projects (${formatPercent(projectFallbacks / attempted.projects)}); ${fileFallbacks}/${attempted.files} files (${formatPercent(fileFallbacks / attempted.files)}).`,
    ].join('\n'),
  );
}

function assertSuccessful(run, projectRoot) {
  if (run.error) {
    throw run.error;
  }
  if (run.status !== 0) {
    throw new Error(
      `verify failed for ${projectRoot} (exit ${run.status}):\n${run.stderr || run.stdout}`,
    );
  }
}

function createResults(benchmarkResults, fixtureResults) {
  const fixtureSourceFiles = sum(
    fixtureResults.map(({ sourceFiles }) => sourceFiles),
  );
  const syntheticProjectAttempts = sum(
    benchmarkResults.map(({ fallback }) => fallback.projectAttempts),
  );
  const syntheticFileAttempts = sum(
    benchmarkResults.map(({ fallback }) => fallback.fileAttempts),
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    note: 'Directional only: this machine was under heavy load, so timings are load-sensitive and must not replace baseline.json.',
    runsPerMode,
    benchmarks: benchmarkResults,
    fallbackSummary: {
      synthetic: {
        fallbackMarkers: 0,
        projectAttempts: syntheticProjectAttempts,
        projectsFellBack: 0,
        projectRate: 0,
        fileAttempts: syntheticFileAttempts,
        filesFellBack: 0,
        fileRate: 0,
      },
      realFixtures: {
        fallbackMarkers: 0,
        projectAttempts: fixtureResults.length,
        projectsFellBack: 0,
        projectRate: 0,
        sourceFiles: fixtureSourceFiles,
        filesFellBack: 0,
        fileRate: 0,
        projects: fixtureResults,
      },
    },
    watchProxy: {
      harness: 'tools/perf/run-handle-bench.mjs',
      note: 'ProjectHandle.applyChanges is the persistent single-file-update path. CLI verify --files filters results after full project initialization and is not an incremental path.',
    },
  };
}

function printBenchmarkTable(results) {
  console.log('\nDirectional verify timings (load-sensitive)');
  console.table(
    results.flatMap((result) => [
      {
        size: result.size,
        mode: 'TypeScript',
        medianMs: result.typescript.medianMs,
        speedup: '1.00x',
      },
      {
        size: result.size,
        mode: 'Rust engine',
        medianMs: result.engine.medianMs,
        speedup: `${result.speedup.toFixed(2)}x`,
      },
    ]),
  );
}

function printFallbackSummary(results) {
  const synthetic = results.fallbackSummary.synthetic;
  const fixtures = results.fallbackSummary.realFixtures;
  console.log(
    `Synthetic engine fallback rate: ${synthetic.projectsFellBack}/${synthetic.projectAttempts} project-runs (${formatPercent(synthetic.projectRate)}); ${synthetic.filesFellBack}/${synthetic.fileAttempts} file-runs (${formatPercent(synthetic.fileRate)}).`,
  );
  console.log(
    `Real-fixture engine fallback rate: ${fixtures.projectsFellBack}/${fixtures.projectAttempts} projects (${formatPercent(fixtures.projectRate)}); ${fixtures.filesFellBack}/${fixtures.sourceFiles} source files (${formatPercent(fixtures.fileRate)}).`,
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function formatPercent(rate) {
  return `${round(rate * 100).toFixed(2)}%`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
