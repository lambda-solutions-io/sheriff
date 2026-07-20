#!/usr/bin/env node

import { resolve } from 'path';
import { useDefaultFs } from '../lib/fs/getFs';
import { generateOracle } from './engine-oracle';

const [projectPath, entryFile] = process.argv.slice(2);

if (projectPath === undefined) {
  console.error('Usage: dump-oracle-cli <project-path> [entry-file]');
  process.exitCode = 1;
} else {
  useDefaultFs();
  const oracleInput = entryFile
    ? resolve(projectPath, entryFile)
    : resolve(projectPath);
  process.stdout.write(`${JSON.stringify(generateOracle(oracleInput), null, 2)}\n`);
}
