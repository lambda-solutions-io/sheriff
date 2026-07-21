import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vitest } from 'vitest';

const require = createRequire(import.meta.url);
const { nativeTriple } = require('../platform.js') as {
  nativeTriple: (options?: {
    platform?: NodeJS.Platform;
    arch?: string;
    report?: { getReport(): { header: Record<string, unknown> } };
  }) => string;
};
const workspaceRoot = resolve(import.meta.dirname, '../../..');
const engineSource = join(workspaceRoot, 'packages/sheriff-engine');
const bindingSource = readFileSync(
  join(engineSource, 'native/binding.js'),
  'utf8',
);

describe('native resolver', () => {
  it('agrees with nativeTriple when only the child-process probe detects musl', () => {
    const report = {
      getReport: () => ({ header: {}, sharedObjects: [] }),
    };
    const triple = nativeTriple({ platform: 'linux', arch: 'x64', report });
    const expectedRequest = `./sheriff-engine.${triple}.node`;
    const requested: string[] = [];
    const execSync = vitest.fn(() => 'musl libc');
    const nativeBinding = {
      ProjectHandle: class {},
      analyzeProject: () => '',
      resolveModuleNameForEngineShadow: () => '',
      resolveProjectImports: () => '',
    };
    const module = { exports: {} };

    runInNewContext(bindingSource, {
      module,
      process: {
        arch: 'x64',
        env: {},
        platform: 'linux',
        report,
      },
      require: (request: string) => {
        if (request === 'fs') {
          return {
            readFileSync: () => {
              throw Object.assign(new Error('missing /usr/bin/ldd'), {
                code: 'ENOENT',
              });
            },
          };
        }
        if (request === 'child_process') return { execSync };
        requested.push(request);
        if (request === expectedRequest) return nativeBinding;
        throw Object.assign(new Error(`Cannot find module '${request}'`), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    });

    expect(triple).toBe('linux-x64-musl');
    expect(execSync).toHaveBeenCalledOnce();
    expect(requested[0]).toBe(expectedRequest);
  });

  it('reports a genuinely absent platform package as native missing', () => {
    expect(loadFailureCode(false)).toBe('SHERIFF_ENGINE_NATIVE_MISSING');
  });

  it('reports a present platform package with a missing main as load failed', () => {
    expect(loadFailureCode(true)).toBe('SHERIFF_ENGINE_NATIVE_LOAD_FAILED');
  });
});

function loadFailureCode(installBrokenPlatformPackage: boolean): string {
  const tempRoot = mkdtempSync('/private/tmp/sheriff-engine-resolver-');
  const engineInstall = join(
    tempRoot,
    'node_modules/@lambda-solutions/sheriff-engine',
  );
  const triple = nativeTriple();

  try {
    mkdirSync(join(engineInstall, 'native'), { recursive: true });
    for (const file of ['index.js', 'package.json', 'platform.js']) {
      cpSync(join(engineSource, file), join(engineInstall, file));
    }
    cpSync(
      join(engineSource, 'native/binding.js'),
      join(engineInstall, 'native/binding.js'),
    );

    if (installBrokenPlatformPackage) {
      const platformInstall = join(
        tempRoot,
        'node_modules/@lambda-solutions',
        `sheriff-engine-${triple}`,
      );
      mkdirSync(platformInstall, { recursive: true });
      writeFileSync(
        join(platformInstall, 'package.json'),
        JSON.stringify({
          name: `@lambda-solutions/sheriff-engine-${triple}`,
          version: '0.0.0',
          main: `sheriff-engine.${triple}.node`,
        }),
      );
    }

    return execFileSync(
      process.execPath,
      [
        '-e',
        "try { require('@lambda-solutions/sheriff-engine').analyzeProject('{}') } catch (error) { process.stdout.write(error.code ?? 'NO_CODE') }",
      ],
      {
        cwd: tempRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_PATH: [
            join(workspaceRoot, 'node_modules'),
            process.env['NODE_PATH'],
          ]
            .filter(Boolean)
            .join(delimiter),
        },
      },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
