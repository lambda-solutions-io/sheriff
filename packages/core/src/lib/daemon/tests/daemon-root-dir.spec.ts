import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../client';
import { DaemonServer, startDaemonServer } from '../server';

/**
 * The daemon must analyse its configured `rootDir`, not `process.cwd()`.
 * Two projects are on disk: the daemon is started for `rootDir` while the
 * process stays in `otherDir`, which has a different config and no
 * violations. Every request has to answer for `rootDir`.
 */
describe('daemon rootDir independence from cwd', () => {
  let rootDir: string;
  let otherDir: string;
  let server: DaemonServer;
  let previousCwd: string;
  const exit = vi.fn();

  beforeAll(async () => {
    previousCwd = process.cwd();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-daemon-root-'));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriff-daemon-other-'));

    writeViolatingProject(rootDir);
    writeCleanProject(otherDir);

    // cwd deliberately differs from rootDir for the whole suite
    process.chdir(otherDir);

    server = await startDaemonServer({ rootDir, exit });
  });

  afterAll(() => {
    process.chdir(previousCwd);
    server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('should return the config of rootDir', async () => {
    const client = await DaemonClient.connect(rootDir);

    const config = (await client!.request('getConfig')) as Record<
      string,
      unknown
    >;

    expect(config['entryFile']).toBe('src/main.ts');
    client!.close();
  });

  it('should verify the project in rootDir', async () => {
    const client = await DaemonClient.connect(rootDir);

    const result = (await client!.request('verify')) as {
      success: boolean;
      encapsulationViolationCount: number;
      violations: Record<string, unknown>;
    };

    // rootDir has one encapsulation violation, otherDir has none
    expect(result.success).toBe(false);
    expect(result.encapsulationViolationCount).toBe(1);
    // violation paths are relative to rootDir, not to cwd
    expect(Object.keys(result.violations)).toEqual(['src/feature/index.ts']);
    client!.close();
  });

  it('should return the project data of rootDir', async () => {
    const client = await DaemonClient.connect(rootDir);

    const projectData = (await client!.request('getProjectData')) as Record<
      string,
      unknown
    >;

    // keys are absolute paths and must all live under rootDir, never otherDir
    expect(Object.keys(projectData)).toContain(
      path.join(rootDir, 'src', 'feature', 'index.ts'),
    );
    expect(
      Object.keys(projectData).every((file) => file.startsWith(rootDir)),
    ).toBe(true);
    client!.close();
  });
});

function writeProject(
  dir: string,
  entryFile: string,
  files: Record<string, string>,
) {
  const write = (relativePath: string, contents: string) => {
    const filePath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  };

  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }),
  );
  write(
    'sheriff.config.ts',
    `export const config = {
  entryFile: '${entryFile}',
  depRules: {
    root: ['root', 'noTag'],
    noTag: ['root', 'noTag'],
  },
};`,
  );

  for (const [relativePath, contents] of Object.entries(files)) {
    write(relativePath, contents);
  }
}

/** `src/feature/index.ts` deep-imports `shared/internal.ts` — one violation. */
function writeViolatingProject(dir: string) {
  writeProject(dir, 'src/main.ts', {
    'src/main.ts': `import './feature';\n`,
    'src/feature/index.ts': `import { internal } from '../shared/internal';\nexport const feature = internal;\n`,
    'src/shared/index.ts': `export const shared = 1;\n`,
    'src/shared/internal.ts': `export const internal = 2;\n`,
  });
}

/** A different entry file and no violations at all. */
function writeCleanProject(dir: string) {
  writeProject(dir, 'src/other-main.ts', {
    'src/other-main.ts': `export const other = 1;\n`,
  });
}
