#!/usr/bin/env node

// Replaces absolute path prefixes (arguments 2..n) with '.' in the given
// text file, so CLI outputs containing machine-specific paths can be
// compared against stable golden files.

import * as fs from 'fs';

const [file, ...prefixes] = process.argv.slice(2);

let content = fs.readFileSync(file, { encoding: 'utf-8' });
for (const prefix of prefixes) {
  content = content.split(prefix).join('.');
}
fs.writeFileSync(file, content, { encoding: 'utf-8' });
