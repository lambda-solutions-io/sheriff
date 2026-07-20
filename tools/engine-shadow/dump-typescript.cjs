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
