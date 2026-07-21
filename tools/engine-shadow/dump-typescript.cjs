'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { useDefaultFs } = require('../../packages/core/src/lib/fs/getFs.ts');
const {
  generateTsData,
} = require('../../packages/core/src/lib/file-info/generate-ts-data.ts');
const {
  resolveImportsForEngineShadow,
} = require('../../packages/core/src/lib/file-info/traverse-filesystem.ts');

useDefaultFs();

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.operation === 'resolve-module-names') {
  const ts = require('typescript');
  const resolutions = input.cases.map(
    ({ containingFile, specifier, compilerOptions = {} }) => ({
      resolvedPath:
        ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys)
          .resolvedModule?.resolvedFileName ?? null,
    }),
  );
  process.stdout.write(
    JSON.stringify({ compilerVersion: ts.version, resolutions }),
  );
  return;
}

if (input.operation === 'reached-files') {
  const reachedByEntry = input.entries.map(({ tsConfigPath, entryFile }) => {
    const tsData = generateTsData(tsConfigPath);
    const reached = new Set();
    const pending = [entryFile];
    while (pending.length > 0) {
      const file = pending.pop();
      if (reached.has(file)) continue;
      reached.add(file);
      for (const edge of resolveImportsForEngineShadow(
        file,
        tsData,
        input.ignoredExtensions,
      )) {
        if (edge.kind === 'module' && edge.resolvedPath !== null) {
          pending.push(path.resolve(tsData.rootDir, edge.resolvedPath));
        }
      }
    }
    return {
      tsConfigPath,
      entryFile,
      rootDir: tsData.rootDir,
      files: [...reached]
        .map((file) => relativePath(tsData.rootDir, file))
        .sort(),
    };
  });
  process.stdout.write(JSON.stringify(reachedByEntry));
  return;
}

const edges = [];
for (const group of input.groups) {
  const tsData = generateTsData(group.tsConfigPath);
  for (const file of group.files) {
    for (const edge of resolveImportsForEngineShadow(
      file,
      tsData,
      input.ignoredExtensions,
    )) {
      edges.push({
        file: relativePath(tsData.rootDir, file),
        ...edge,
      });
    }
  }
}

process.stdout.write(JSON.stringify(edges));

function relativePath(root, target) {
  const relative = path.relative(root, target).replaceAll('\\', '/');
  return relative || '.';
}
