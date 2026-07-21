import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const napiCli = path.join(
  packageDir,
  'node_modules',
  '@napi-rs',
  'cli',
  'dist',
  'cli.js',
);
const manifestPath = path.join(packageDir, 'crate', 'Cargo.toml');
const napiPackage = JSON.parse(
  await readFile(
    path.join(packageDir, 'node_modules', '@napi-rs', 'cli', 'package.json'),
    'utf8',
  ),
);
const typeDefCacheKey = createHash('sha256')
  .update(manifestPath)
  .update(napiPackage.version)
  .digest('hex')
  .slice(0, 8);
const typeDefPath = path.join(
  packageDir,
  '..',
  '..',
  'target',
  'napi-rs',
  `sheriff_engine-${typeDefCacheKey}`,
  'sheriff_engine',
);

await new Promise((resolve, reject) => {
  const napi = spawn(
    process.execPath,
    [
      napiCli,
      'build',
      '--platform',
      '--release',
      '--manifest-path',
      'crate/Cargo.toml',
      '--output-dir',
      'native',
      '--js',
      'binding.js',
      '--dts',
      'binding.d.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        CARGO_NET_OFFLINE: 'true',
        // napi v3 reads one JSONL file per crate. The current napi-derive v2
        // macro still uses its legacy file env, so point it at v3's cache.
        TYPE_DEF_TMP_PATH: typeDefPath,
      },
      stdio: 'inherit',
    },
  );

  napi.once('error', reject);
  napi.once('exit', (code, signal) => {
    if (code === 0) {
      resolve();
    } else {
      reject(
        new Error(
          `napi build failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
        ),
      );
    }
  });
});

const bindingDtsPath = path.join(packageDir, 'native', 'binding.d.ts');
const bindingDts = await readFile(bindingDtsPath, 'utf8');
await writeFile(
  bindingDtsPath,
  // napi-derive v2 includes this prefix, while napi CLI v3 adds it itself.
  bindingDts
    .replace('/* eslint-disable */\n', '')
    .replaceAll('export declare export declare ', 'export declare '),
);
