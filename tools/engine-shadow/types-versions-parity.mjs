import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveModuleNameForEngineShadow, resolveProjectImports } = require(
  '../../packages/sheriff-engine/index.js',
);
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, '../..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-types-versions-'));

try {
  const cases = createCases(tempRoot);
  const typescript = dumpTypeScript(cases);
  if (typescript.compilerVersion !== '5.9.3') {
    throw new Error(
      `typesVersions parity expects TypeScript 5.9.3, found ${typescript.compilerVersion}`,
    );
  }

  const results = cases.map((testCase, index) => {
    const rust = JSON.parse(
      resolveModuleNameForEngineShadow({
        schemaVersion: 1,
        tsConfigPath: testCase.tsConfigPath,
        containingFile: testCase.containingFile,
        specifier: testCase.specifier,
      }),
    );
    if (rust.error) throw new Error(`${testCase.name}: ${rust.error.message}`);
    const typescriptPath = canonicalPath(
      typescript.resolutions[index].resolvedPath,
    );
    const rustPath = canonicalPath(rust.resolvedPath);
    return {
      name: testCase.name,
      typescriptPath,
      rustPath,
      passed: typescriptPath === rustPath,
    };
  });

  const unimported = cases.find((testCase) => testCase.name === 'unimported-package');
  const unimportedProject = JSON.parse(
    resolveProjectImports({
      schemaVersion: 1,
      tsConfigPath: unimported.tsConfigPath,
      files: [unimported.containingFile],
      ignoreFileExtensions: [],
      shadowMode: false,
    }),
  );
  if (unimportedProject.error || unimportedProject.fallback) {
    throw new Error(
      `unimported-package unexpectedly fell back: ${JSON.stringify(unimportedProject)}`,
    );
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    throw new Error(
      `typesVersions differential divergence:\n${failed
        .map(
          ({ name, typescriptPath, rustPath }) =>
            `- ${name}: TS=${typescriptPath}; Rust=${rustPath}`,
        )
        .join('\n')}`,
    );
  }
  process.stdout.write(`${JSON.stringify({ compilerVersion: typescript.compilerVersion, results })}\n`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function createCases(root) {
  const synthetic = path.join(root, 'synthetic');
  write(path.join(synthetic, 'tsconfig.json'), '{}');
  write(
    path.join(synthetic, 'src/main.ts'),
    [
      "import './local';",
      "import 'first-match';",
      "import 'best-pattern/feature/deep/item';",
      "import 'invalid-range';",
      "import '@scope/versioned/subpath';",
      '',
    ].join('\n'),
  );
  write(path.join(synthetic, 'src/local.ts'), 'export {};\n');

  packageFixture(synthetic, 'first-match', {
    types: 'index.d.ts',
    typesVersions: {
      '>=4.0': { '*': ['first/*'] },
      '>=5.0': { '*': ['second/*'] },
    },
    files: ['first/index.d.ts', 'second/index.d.ts', 'index.d.ts'],
  });
  packageFixture(synthetic, 'best-pattern', {
    typesVersions: {
      '*': {
        'feature*': ['short/*'],
        'feature/deep*': ['long/*'],
      },
    },
    files: ['short//deep/item.d.ts', 'long//item.d.ts'],
  });
  packageFixture(synthetic, 'invalid-range', {
    types: 'original/index.d.ts',
    typesVersions: {
      'not a semver range': { '*': ['wrong/*'] },
    },
    files: ['original/index.d.ts', 'wrong/index.d.ts'],
  });
  packageFixture(synthetic, 'unimported', {
    typesVersions: { '*': { '*': ['types/*'] } },
    files: ['types/index.d.ts'],
  });
  packageFixture(synthetic, '@scope/versioned', {
    typesVersions: { '*': { '*': ['types/*'] } },
    files: ['types/subpath.d.ts'],
  });

  const realContainingFile = path.join(
    repoRoot,
    'test-projects/angular-i/tests/customers-container.deep-import.component.ts',
  );
  const realConfig = path.join(repoRoot, 'test-projects/angular-i/tsconfig.json');
  const syntheticConfig = path.join(synthetic, 'tsconfig.json');
  const syntheticContainingFile = path.join(synthetic, 'src/main.ts');
  return [
    caseOf('rxjs-root', realConfig, realContainingFile, 'rxjs'),
    caseOf('rxjs-subpath', realConfig, realContainingFile, 'rxjs/operators'),
    caseOf('first-matching-range', syntheticConfig, syntheticContainingFile, 'first-match'),
    caseOf(
      'longest-pattern-prefix',
      syntheticConfig,
      syntheticContainingFile,
      'best-pattern/feature/deep/item',
    ),
    caseOf('invalid-range-skipped', syntheticConfig, syntheticContainingFile, 'invalid-range'),
    caseOf('unimported-package', syntheticConfig, syntheticContainingFile, './local'),
    caseOf(
      'scoped-package-subpath',
      syntheticConfig,
      syntheticContainingFile,
      '@scope/versioned/subpath',
    ),
  ];
}

function caseOf(name, tsConfigPath, containingFile, specifier) {
  return { name, tsConfigPath, containingFile, specifier };
}

function packageFixture(root, name, { files, ...manifest }) {
  const packageRoot = path.join(root, 'node_modules', name);
  write(path.join(packageRoot, 'package.json'), JSON.stringify({ name, ...manifest }));
  for (const file of files) write(path.join(packageRoot, file), 'export {};\n');
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function dumpTypeScript(cases) {
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
      input: JSON.stringify({ operation: 'resolve-module-names', cases }),
      env: {
        ...process.env,
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({
          module: 'CommonJS',
          moduleResolution: 'node',
        }),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`TypeScript resolver failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function canonicalPath(file) {
  return file === null ? null : fs.realpathSync(file).replaceAll('\\', '/');
}
