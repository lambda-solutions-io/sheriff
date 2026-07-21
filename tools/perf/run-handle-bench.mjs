import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { generateBenchProject } from './gen-bench.mjs';

const require = createRequire(import.meta.url);
const { ProjectHandle } = require('../../packages/sheriff-engine/index.js');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeDirectory = join(repoRoot, 'packages/sheriff-engine/native');

if (!existsSync(nativeDirectory)) {
  throw new Error(
    'Native engine is missing. Run node packages/sheriff-engine/scripts/build-native.mjs first.',
  );
}

const project = generateBenchProject(join(repoRoot, 'tmp/perf/handle-10.5k'), {
  domains: 500,
  modulesPerDomain: 3,
  filesPerModule: 6,
});
const moduleTypes = ['feature', 'data', 'model'];
const modulePaths = Array.from({ length: project.domains }, (_, domain) =>
  moduleTypes.map((type) => ({
    path: join(project.root, 'src', 'app', `domain-${domain}`, type),
    isBarrel: true,
  })),
).flat();
const entryFile = join(project.root, 'src/main.ts');
const changedFile = join(project.root, 'src/app/domain-499/model/file-5.ts');
const hubSize = 50;
const hubCount = Math.ceil(project.domains / hubSize);
const mainImports = [];
for (let hub = 0; hub < hubCount; hub += 1) {
  const hubFile = join(project.root, 'src', `entry-hub-${hub}.ts`);
  const firstDomain = hub * hubSize;
  const lastDomain = Math.min(firstDomain + hubSize, project.domains);
  writeFileSync(
    hubFile,
    `${Array.from(
      { length: lastDomain - firstDomain },
      (_, offset) =>
        `import './app/domain-${firstDomain + offset}/feature';`,
    ).join('\n')}\n`,
  );
  mainImports.push(`import './entry-hub-${hub}';`);
}
writeFileSync(entryFile, `${mainImports.join('\n')}\n`);

const constructionStarted = performance.now();
const handle = new ProjectHandle({
  schemaVersion: 1,
  entryFile,
  tsConfigPath: join(project.root, 'tsconfig.json'),
  modulePaths,
  moduleConfig: {
    'src/app': {
      '<domain>/<type>': ['domain:<domain>', 'type:<type>'],
    },
  },
  autoTagging: true,
  depRules: { '*': '*' },
  denyRules: {},
  externalRules: {},
  enableBarrelLess: false,
  excludeRoot: false,
  barrelFileName: 'index.ts',
});
const constructionMs = performance.now() - constructionStarted;
assertComplete(handle.getResult());

const original = readFileSync(changedFile, 'utf8');
const runsMs = [];
for (let run = 0; run < 9; run += 1) {
  writeFileSync(changedFile, `${original}\n// update ${run % 2}\n`);
  const startedAt = performance.now();
  const output = handle.applyChanges({
    schemaVersion: 1,
    events: [{ kind: 'modified', path: changedFile }],
  });
  runsMs.push(performance.now() - startedAt);
  assertComplete(output);
}
writeFileSync(changedFile, original);

const sorted = [...runsMs].sort((left, right) => left - right);
const result = {
  projectFiles: project.files + hubCount,
  reachedFiles: JSON.parse(handle.getReachedFiles()).files.length,
  modules: modulePaths.length,
  changedFile,
  constructionMs: round(constructionMs),
  updateMedianMs: round(sorted[Math.floor(sorted.length / 2)]),
  updateP95Ms: round(sorted[Math.floor(sorted.length * 0.95)]),
  updateRunsMs: runsMs.map(round),
};
console.table(result);
console.log(JSON.stringify(result));

function assertComplete(serialized) {
  const output = JSON.parse(serialized);
  if (output.error || !output.violations) {
    throw new Error(`ProjectHandle failed: ${serialized}`);
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}
