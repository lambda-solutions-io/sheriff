#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  resolveProjectImports,
} = require('../../packages/sheriff-engine/index.js');

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, '../..');
const fixturesRoot = path.join(repoRoot, 'test-projects');
const reportPath = path.join(toolDir, 'report.json');
const summaryPath = path.join(toolDir, 'summary.txt');

// Mirrors packages/core/src/lib/config/default-file-extensions.ts. Shadow mode
// intentionally tests the shipped default, not fixture-specific test configs.
const ignoredExtensions = [
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'css',
  'scss',
  'sass',
  'less',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'otf',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'mov',
  'json',
  'csv',
  'xml',
  'txt',
  'md',
];
const sourceExtensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);
const ignoredDirectories = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'out-tsc',
  'public',
  'expected',
  'actual',
]);

const fixtureNames = fs
  .readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const projects = [];
for (const name of fixtureNames) {
  const fixtureDir = path.join(fixturesRoot, name);
  try {
    projects.push(runFixture(name, fixtureDir));
  } catch (error) {
    projects.push({
      project: name,
      status: 'skipped',
      skipReasons: [`harness error: ${error?.stack ?? error}`],
      hasInstalledNodeModules: directoryExists(
        path.join(fixtureDir, 'node_modules'),
      ),
      filesCompared: 0,
      edges: { typescript: 0, rust: 0 },
      engineFallback: uncheckedFallback(),
      divergences: emptyDivergenceSummary(),
    });
  }
}

const totals = projects.reduce(
  (result, project) => {
    result.fixturesDiscovered += 1;
    result[project.status] += 1;
    result.filesCompared += project.filesCompared;
    result.typescriptEdges += project.edges.typescript;
    result.rustEdges += project.edges.rust;
    if (project.engineFallback.checked) {
      result.fallbackRate.fixturesChecked += 1;
      if (project.engineFallback.fellBack)
        result.fallbackRate.fixturesFellBack += 1;
    }
    for (const kind of Object.keys(result.divergences)) {
      result.divergences[kind] += project.divergences[kind].count;
    }
    return result;
  },
  {
    fixturesDiscovered: 0,
    passed: 0,
    fallback: 0,
    skipped: 0,
    filesCompared: 0,
    typescriptEdges: 0,
    rustEdges: 0,
    fallbackRate: {
      fixturesFellBack: 0,
      fixturesChecked: 0,
      percentage: 0,
      summary: '',
    },
    divergences: {
      kindMismatch: 0,
      pathMismatch: 0,
      missingEdge: 0,
      extraEdge: 0,
    },
  },
);
totals.fallbackRate.percentage =
  totals.fallbackRate.fixturesChecked === 0
    ? 0
    : (totals.fallbackRate.fixturesFellBack /
        totals.fallbackRate.fixturesChecked) *
      100;
totals.fallbackRate.summary = `${totals.fallbackRate.fixturesFellBack}/${totals.fallbackRate.fixturesChecked} fixtures fell back`;

const report = {
  schemaVersion: 1,
  contract:
    'ts.preProcessFile + sheriff TypeScript resolution versus oxc_parser + oxc_resolver',
  totals,
  projects,
};
const summary = renderSummary(report);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(summaryPath, summary);
process.stdout.write(summary);

const divergenceCount = Object.values(totals.divergences).reduce(
  (sum, count) => sum + count,
  0,
);
if (divergenceCount > 0 || totals.skipped > 0) process.exitCode = 1;

function runFixture(name, fixtureDir) {
  const sourceFiles = findSourceFiles(fixtureDir);
  if (sourceFiles.length === 0) {
    return {
      project: name,
      status: 'skipped',
      skipReasons: ['no JavaScript or TypeScript source files found'],
      hasInstalledNodeModules: directoryExists(
        path.join(fixtureDir, 'node_modules'),
      ),
      filesCompared: 0,
      edges: { typescript: 0, rust: 0 },
      engineFallback: uncheckedFallback(),
      divergences: emptyDivergenceSummary(),
    };
  }

  const groups = new Map();
  for (const file of sourceFiles) {
    const config = findNearestParentFile(file, 'tsconfig.json');
    if (!config) continue;
    const files = groups.get(config) ?? [];
    files.push(file);
    groups.set(config, files);
  }
  if (groups.size === 0) {
    return {
      project: name,
      status: 'skipped',
      skipReasons: ['no source file has a parent tsconfig.json'],
      hasInstalledNodeModules: directoryExists(
        path.join(fixtureDir, 'node_modules'),
      ),
      filesCompared: 0,
      edges: { typescript: 0, rust: 0 },
      engineFallback: uncheckedFallback(),
      divergences: emptyDivergenceSummary(),
    };
  }

  const tsEdges = dumpTypeScriptEdges(groups);
  const rustEdges = [];
  const fallbackReasons = [];
  for (const [tsConfigPath, files] of groups) {
    const native = JSON.parse(
      resolveProjectImports({
        schemaVersion: 1,
        tsConfigPath,
        files,
        ignoreFileExtensions: ignoredExtensions,
        shadowMode: true,
      }),
    );
    if (native.error)
      throw new Error(`${native.error.code}: ${native.error.message}`);
    if (native.fallback) {
      fallbackReasons.push(...native.fallbackReasons);
    }
    for (const file of native.files) {
      for (const edge of file.imports) {
        rustEdges.push({
          file: file.file,
          raw: edge.raw,
          kind: edge.kind,
          resolvedPath: edge.resolvedPath,
        });
      }
    }
  }

  const divergences = diffEdges(tsEdges, rustEdges);
  const engineFallback = {
    checked: true,
    fellBack: fallbackReasons.length > 0,
    reasons: [...new Set(fallbackReasons)].sort(),
  };
  if (fallbackReasons.length > 0) {
    return {
      project: name,
      status: 'fallback',
      skipReasons: [],
      hasInstalledNodeModules: directoryExists(
        path.join(fixtureDir, 'node_modules'),
      ),
      filesCompared: sourceFiles.length,
      sourceFilesDiscovered: sourceFiles.length,
      tsconfigGroups: groups.size,
      edges: { typescript: tsEdges.length, rust: rustEdges.length },
      engineFallback,
      divergences,
    };
  }

  const count = Object.values(divergences).reduce(
    (sum, entry) => sum + entry.count,
    0,
  );
  return {
    project: name,
    status: count === 0 ? 'passed' : 'fallback',
    skipReasons:
      count === 0
        ? []
        : ['shadow divergence: project must remain on TypeScript'],
    hasInstalledNodeModules: directoryExists(
      path.join(fixtureDir, 'node_modules'),
    ),
    sourceFilesDiscovered: sourceFiles.length,
    tsconfigGroups: groups.size,
    filesCompared: sourceFiles.length,
    edges: { typescript: tsEdges.length, rust: rustEdges.length },
    engineFallback,
    divergences,
  };
}

function dumpTypeScriptEdges(groups) {
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(toolDir, 'dump-typescript.cjs'),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        groups: [...groups].map(([tsConfigPath, files]) => ({
          tsConfigPath,
          files,
        })),
        ignoredExtensions,
      }),
      env: {
        ...process.env,
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({
          module: 'CommonJS',
          moduleResolution: 'node',
        }),
      },
      maxBuffer: 100 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `TypeScript edge dumper failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

function diffEdges(tsEdges, rustEdges) {
  const result = emptyDivergenceSummary();
  const tsGroups = groupEdges(tsEdges);
  const rustGroups = groupEdges(rustEdges);
  const keys = new Set([...tsGroups.keys(), ...rustGroups.keys()]);
  for (const key of [...keys].sort()) {
    const left = tsGroups.get(key) ?? [];
    const right = rustGroups.get(key) ?? [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const tsEdge = left[index];
      const rustEdge = right[index];
      if (!rustEdge)
        addDivergence(result.missingEdge, {
          file: tsEdge.file,
          specifier: tsEdge.raw,
          typescript: tsEdge,
          rust: null,
        });
      else if (!tsEdge)
        addDivergence(result.extraEdge, {
          file: rustEdge.file,
          specifier: rustEdge.raw,
          typescript: null,
          rust: rustEdge,
        });
      else if (tsEdge.kind !== rustEdge.kind)
        addDivergence(result.kindMismatch, {
          file: tsEdge.file,
          specifier: tsEdge.raw,
          typescript: tsEdge,
          rust: rustEdge,
        });
      else if (tsEdge.resolvedPath !== rustEdge.resolvedPath)
        addDivergence(result.pathMismatch, {
          file: tsEdge.file,
          specifier: tsEdge.raw,
          typescript: tsEdge,
          rust: rustEdge,
        });
    }
  }
  return result;
}

function groupEdges(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = `${edge.file}\0${edge.raw}`;
    const values = groups.get(key) ?? [];
    values.push(edge);
    groups.set(key, values);
  }
  return groups;
}

function emptyDivergenceSummary() {
  return {
    kindMismatch: { count: 0, examples: [] },
    pathMismatch: { count: 0, examples: [] },
    missingEdge: { count: 0, examples: [] },
    extraEdge: { count: 0, examples: [] },
  };
}

function uncheckedFallback() {
  return { checked: false, fellBack: false, reasons: [] };
}

function addDivergence(category, example) {
  category.count += 1;
  if (category.examples.length < 5) category.examples.push(example);
}

function findSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findSourceFiles(fullPath));
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name)))
      files.push(fullPath);
  }
  return files.sort();
}

function findNearestParentFile(referenceFile, filename) {
  let current = path.dirname(referenceFile);
  while (true) {
    const candidate = path.join(current, filename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function directoryExists(directory) {
  return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
}

function renderSummary(report) {
  const lines = [
    'Sheriff Rust engine R2 shadow report',
    '',
    `Fixtures: ${report.totals.passed} passed, ${report.totals.fallback} project fallbacks, ${report.totals.skipped} skipped (${report.totals.fixturesDiscovered} discovered)`,
    `Fallback rate: ${report.totals.fallbackRate.summary} (${report.totals.fallbackRate.percentage.toFixed(1)}%)`,
    `Coverage: ${report.totals.filesCompared} source files; ${report.totals.typescriptEdges} TS edges; ${report.totals.rustEdges} Rust edges`,
    `Divergences: kind=${report.totals.divergences.kindMismatch}, path=${report.totals.divergences.pathMismatch}, missing=${report.totals.divergences.missingEdge}, extra=${report.totals.divergences.extraEdge}`,
    '',
  ];
  for (const project of report.projects) {
    const dependencyCoverage = project.hasInstalledNodeModules
      ? 'installed dependencies present'
      : 'no fixture-local node_modules; ancestor installs may still resolve';
    const engineFallback = project.engineFallback.checked
      ? project.engineFallback.fellBack
        ? 'yes'
        : 'no'
      : 'not checked';
    lines.push(
      `- ${project.project}: ${project.status}; engine fallback=${engineFallback}; files=${project.filesCompared}; TS=${project.edges.typescript}; Rust=${project.edges.rust}; ${dependencyCoverage}`,
    );
    for (const reason of project.engineFallback.reasons)
      lines.push(`  fallback reason: ${reason}`);
    for (const reason of project.skipReasons) lines.push(`  reason: ${reason}`);
    for (const [kind, details] of Object.entries(project.divergences)) {
      if (details.count > 0)
        lines.push(
          `  ${kind}: ${details.count}; example=${JSON.stringify(details.examples[0])}`,
        );
    }
  }
  lines.push('', `Machine report: ${path.relative(repoRoot, reportPath)}`, '');
  return `${lines.join('\n')}\n`;
}
