import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { version as packageVersion } from '../../../../package.json';
import { DaemonClient, getDaemonStatus, stopDaemon } from '../client';
import { DaemonServer, startDaemonServer } from '../server';
import { HandshakeResult } from '../protocol';

const nativeDirectory = path.resolve(
  __dirname,
  '../../../../../sheriff-engine/native',
);
const nativeAvailable =
  fs.existsSync(nativeDirectory) &&
  fs.readdirSync(nativeDirectory).some((file) => file.endsWith('.node'));

/**
 * End-to-end over a real socket against a minimal on-disk project:
 * `src/main.ts` imports `feature/index.ts`, which deep-imports into
 * `shared/internal.ts` — an encapsulation violation.
 */
describe('daemon integration', () => {
  let rootDir: string;
  let server: DaemonServer | undefined;
  let previousCwd: string;
  const exit = vi.fn();
  const log = vi.fn();
  const originalEngineFlag = process.env['SHERIFF_ENGINE'];
  const originalEngineDebug = process.env['SHERIFF_ENGINE_DEBUG'];

  beforeAll(async () => {
    previousCwd = process.cwd();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-daemon-spec-'));

    writeFixtureProject(rootDir);
    process.chdir(rootDir);
    delete process.env['SHERIFF_ENGINE'];

    server = await startDaemonServer({ rootDir, exit, log });
  });

  afterAll(() => {
    if (originalEngineFlag === undefined) {
      delete process.env['SHERIFF_ENGINE'];
    } else {
      process.env['SHERIFF_ENGINE'] = originalEngineFlag;
    }
    if (originalEngineDebug === undefined) {
      delete process.env['SHERIFF_ENGINE_DEBUG'];
    } else {
      process.env['SHERIFF_ENGINE_DEBUG'] = originalEngineDebug;
    }
    process.chdir(previousCwd);
    server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('should complete a handshake for the matching version', async () => {
    const client = await DaemonClient.connect(rootDir);
    expect(client).toBeDefined();

    const handshake = (await client!.request('handshake', {
      coreVersion: packageVersion,
    })) as HandshakeResult;

    expect(handshake.coreVersion).toBe(packageVersion);
    expect(handshake.rootDir).toBe(rootDir);
    expect(handshake.pid).toBe(process.pid);
    client!.close();
  });

  it('should report the status', async () => {
    const status = await getDaemonStatus(rootDir);
    expect(status?.pid).toBe(process.pid);
  });

  it('should verify the project over the socket', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('verify')) as {
      success: boolean;
      encapsulationViolationCount: number;
    };

    expect(result.success).toBe(false);
    expect(result.encapsulationViolationCount).toBe(1);
    client!.close();
  });

  it('should return the config without functions', async () => {
    const client = await DaemonClient.connect(rootDir);

    const config = (await client!.request('getConfig')) as Record<
      string,
      unknown
    >;

    expect(config['entryFile']).toBe('src/main.ts');
    expect(JSON.stringify(config)).not.toContain('function');
    client!.close();
  });

  it('should lint a single file', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
    })) as { encapsulationViolations: string[] };

    expect(result.encapsulationViolations).toHaveLength(1);
    client!.close();
  });

  it('should lint unsaved content without touching the cache', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
      fileContent: 'export const clean = 1;',
    })) as { encapsulationViolations: string[] };

    expect(result.encapsulationViolations).toHaveLength(0);

    // the on-disk state must be unaffected by the unsaved buffer
    const onDisk = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
    })) as { encapsulationViolations: string[] };
    expect(onDisk.encapsulationViolations).toHaveLength(1);
    client!.close();
  });

  it('should surface unresolvable relative imports', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('lintFile', {
      filename: path.join(rootDir, 'src', 'feature', 'index.ts'),
      // a typo'd relative import the resolved-import checks never surface
      fileContent: "import { x } from './does-not-exist';\nexport const y = x;",
    })) as { unresolvableImports: string[] };

    expect(result.unresolvableImports).toContain('./does-not-exist');
    client!.close();
  });

  it.skipIf(!nativeAvailable)(
    'should return the byte-identical lint DTO through the engine',
    async () => {
      const previousDebug = process.env['SHERIFF_ENGINE_DEBUG'];
      const debug = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      process.env['SHERIFF_ENGINE_DEBUG'] = '1';
      await withEngineDaemon(async (engineRoot) => {
        const client = await DaemonClient.connect(engineRoot);
        const filename = path.join(engineRoot, 'src', 'feature', 'index.ts');
        const engineResult = await client!.request('lintFile', { filename });

        expect(engineResult).toEqual({
          dependencyRuleViolations: [
            {
              fromTag: 'feature',
              toTags: ['shared'],
              rawImport: '../shared/internal',
            },
          ],
          encapsulationViolations: ['../shared/internal'],
          externalRuleViolations: [
            { fromTag: 'feature', externalLibrary: 'blocked-lib' },
          ],
          unresolvableImports: ['./missing'],
        });
        client!.close();
      });
      expect(debug).not.toHaveBeenCalled();
      if (previousDebug === undefined) {
        delete process.env['SHERIFF_ENGINE_DEBUG'];
      } else {
        process.env['SHERIFF_ENGINE_DEBUG'] = previousDebug;
      }
    },
  );

  it.skipIf(!nativeAvailable)(
    'should fall back for a file outside the configured entry graph',
    async () => {
      await withEngineDaemon(async (engineRoot) => {
        const client = await DaemonClient.connect(engineRoot);
        const filename = path.join(engineRoot, 'src', 'uncovered.ts');
        const fallbackResult = await client!.request('lintFile', { filename });

        expect(fallbackResult).toEqual({
          dependencyRuleViolations: [],
          encapsulationViolations: [],
          externalRuleViolations: [],
          unresolvableImports: [],
        });
        client!.close();
      });
    },
  );

  it.skipIf(!nativeAvailable)(
    'should rebuild the engine host after watcher invalidation',
    async () => {
      await withEngineDaemon(async (engineRoot, engineLog) => {
        const client = await DaemonClient.connect(engineRoot);
        const filename = path.join(engineRoot, 'src', 'feature', 'index.ts');

        const before = (await client!.request('lintFile', { filename })) as {
          dependencyRuleViolations: unknown[];
        };
        expect(before.dependencyRuleViolations).toHaveLength(1);

        const previousLogCount = engineLog.mock.calls.length;
        fs.writeFileSync(filename, 'export const feature = true;\n');
        await vi.waitFor(
          () => {
            expect(
              engineLog.mock.calls
                .slice(previousLogCount)
                .some(([message]) => String(message).includes('invalidated')),
            ).toBe(true);
          },
          { timeout: 3_000 },
        );

        const after = (await client!.request('lintFile', { filename })) as {
          dependencyRuleViolations: unknown[];
          encapsulationViolations: unknown[];
          externalRuleViolations: unknown[];
          unresolvableImports: unknown[];
        };
        expect(after).toEqual({
          dependencyRuleViolations: [],
          encapsulationViolations: [],
          externalRuleViolations: [],
          unresolvableImports: [],
        });
        client!.close();
      });
    },
  );

  it('should reject unknown methods', async () => {
    const client = await DaemonClient.connect(rootDir);

    await expect(client!.request('nope')).rejects.toThrow(
      'unknown method nope',
    );
    client!.close();
  });

  it('should shut down on version mismatch', async () => {
    const client = await DaemonClient.connect(rootDir);

    await expect(
      client!.request('handshake', { coreVersion: '0.0.0-other' }),
    ).rejects.toThrow('version mismatch');
    client!.close();

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it('should report no daemon after shutdown', async () => {
    expect(await stopDaemon(rootDir)).toBe(false);
    expect(await getDaemonStatus(rootDir)).toBeUndefined();
  });
});

async function withEngineDaemon(
  run: (
    engineRoot: string,
    engineLog: ReturnType<typeof vi.fn>,
  ) => Promise<void>,
): Promise<void> {
  const previousCwd = process.cwd();
  const previousEngineFlag = process.env['SHERIFF_ENGINE'];
  const engineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'sheriff-engine-daemon-spec-'),
  );
  const engineLog = vi.fn();
  let engineServer: DaemonServer | undefined;

  try {
    writeFixtureProject(engineRoot);
    process.chdir(engineRoot);
    process.env['SHERIFF_ENGINE'] = '1';
    engineServer = await startDaemonServer({
      rootDir: engineRoot,
      exit: vi.fn(),
      log: engineLog,
    });
    await run(engineRoot, engineLog);
  } finally {
    engineServer?.close();
    process.chdir(previousCwd);
    if (previousEngineFlag === undefined) {
      delete process.env['SHERIFF_ENGINE'];
    } else {
      process.env['SHERIFF_ENGINE'] = previousEngineFlag;
    }
    fs.rmSync(engineRoot, { recursive: true, force: true });
  }
}

function writeFixtureProject(rootDir: string) {
  const write = (relativePath: string, contents: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  };

  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }),
  );
  write(
    'package.json',
    JSON.stringify({ dependencies: { 'blocked-lib': '1.0.0' } }),
  );
  write(
    'sheriff.config.ts',
    `export const config = {
  entryFile: 'src/main.ts',
  modules: {
    'src/feature': 'feature',
    'src/shared': 'shared',
  },
  depRules: {
    root: ['root', 'feature'],
    feature: [],
    shared: '*',
  },
  externalRules: {
    feature: [],
  },
};`,
  );
  write('src/main.ts', `import './feature';\n`);
  write(
    'src/feature/index.ts',
    `import 'blocked-lib';
import { internal } from '../shared/internal';
import './missing';
export const feature = internal;
`,
  );
  write('src/shared/index.ts', `export const shared = 1;\n`);
  write('src/shared/internal.ts', `export const internal = 2;\n`);
  write('src/uncovered.ts', `export const uncovered = true;\n`);
}
