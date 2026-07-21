import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearProjectCache } from '../../cache/project-cache';
import { useDefaultFs } from '../../fs/getFs';
import { verify } from '../verify';
import { mockCli } from './helpers/mock-cli';

const workspaceRoot = process.cwd();
const originalEngine = process.env['SHERIFF_ENGINE'];
const originalEngineDebug = process.env['SHERIFF_ENGINE_DEBUG'];

describe('verify with the Rust engine', () => {
  beforeEach(() => {
    vitest.restoreAllMocks();
    useDefaultFs();
    clearProjectCache();
  });

  afterEach(() => {
    process.chdir(workspaceRoot);
    restoreEnvironment('SHERIFF_ENGINE', originalEngine);
    restoreEnvironment('SHERIFF_ENGINE_DEBUG', originalEngineDebug);
    vitest.restoreAllMocks();
    clearProjectCache();
  });

  it('matches the TypeScript output for a passing test-project fixture', () => {
    process.chdir(resolve(workspaceRoot, 'test-projects/angular-v-multi'));

    const typescript = captureVerify(false, []);
    const engine = captureVerify(true, [], {}, true);

    expect(engine).toEqual(typescript);
    expect(engine.logs).toContain('No issues found');
    expect(engine.fallbackLogs).toEqual([]);
  });

  it('matches dependency and encapsulation output for a violating fixture', () => {
    process.chdir(resolve(workspaceRoot, 'test-projects/typescript-i'));

    const typescript = captureVerify(false, ['src/main.ts']);
    const engine = captureVerify(true, ['src/main.ts'], {}, true);

    expect(engine).toEqual(typescript);
    expect(engine.logs).toContain('Dependency Rule Violations');
    expect(engine.logs).toContain('Encapsulation Violations');
    expect(engine.fallbackLogs).toEqual([]);
  });

  it('matches all three violation categories without falling back', () => {
    const project = createViolationProject();
    process.chdir(project);

    try {
      const typescript = captureVerify(false, []);
      const engine = captureVerify(true, [], {}, true);

      expect(engine).toEqual(typescript);
      expect(engine.logs).toContain('Dependency Rule Violations');
      expect(engine.logs).toContain('Encapsulation Violations');
      expect(engine.logs).toContain('External Rule Violations');
      expect(engine.logs).toContain('to tags target:z, target:a');
      expect(engine.fallbackLogs).toEqual([]);
    } finally {
      process.chdir(workspaceRoot);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('matches --files output for the requested violating file only', () => {
    process.chdir(resolve(workspaceRoot, 'test-projects/typescript-i'));
    const options = { files: ['src/web/checkout-controller.ts'] };

    const typescript = captureVerify(false, ['src/main.ts'], options);
    const engine = captureVerify(true, ['src/main.ts'], options, true);

    expect(engine).toEqual(typescript);
    expect(engine.logs).toContain('|-- src/web/checkout-controller.ts');
    expect(engine.logs).not.toContain('|-- src/main.ts');
    expect(engine.fallbackLogs).toEqual([]);
  });

  it('silently falls back when the engine refuses a RegExp rule', () => {
    const project = createRegExpFallbackProject();
    process.chdir(project);

    try {
      const typescript = captureVerify(false, []);
      const engine = captureVerify(true, [], {}, true);

      expect(engine.logs).toBe(typescript.logs);
      expect(engine.errorLogs).toBe(typescript.errorLogs);
      expect(engine.exit).toBe(typescript.exit);
      expect(engine.fallbackLogs).toEqual([
        expect.stringContaining('SHERIFF_ENGINE_UNSUPPORTED_CONFIG'),
      ]);
    } finally {
      process.chdir(workspaceRoot);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('falls back when deny rules contain inherited enumerable keys', () => {
    const project = createInheritedRulesFallbackProject();
    process.chdir(project);

    try {
      const typescript = captureVerify(false, []);
      const engine = captureVerify(true, [], {}, true);

      expect(engine.logs).toBe(typescript.logs);
      expect(engine.errorLogs).toBe(typescript.errorLogs);
      expect(engine.exit).toBe(typescript.exit);
      expect(engine.exit).toBe('error');
      expect(engine.fallbackLogs).toEqual([
        expect.stringContaining('config.denyRules'),
      ]);
    } finally {
      process.chdir(workspaceRoot);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('falls back when a rule callback mutates the context it receives', () => {
    const project = createMutatingCallbackFallbackProject();
    process.chdir(project);

    try {
      const typescript = captureVerify(false, []);
      const engine = captureVerify(true, [], {}, true);

      expect(engine.logs).toBe(typescript.logs);
      expect(engine.errorLogs).toBe(typescript.errorLogs);
      expect(engine.exit).toBe(typescript.exit);
      expect(engine.logs).toContain('to tags target:a, target:m, target:z');
      expect(engine.fallbackLogs).toEqual([
        expect.stringContaining('callback mutated its arguments'),
      ]);
    } finally {
      process.chdir(workspaceRoot);
      rmSync(project, { recursive: true, force: true });
    }
  });
});

type CapturedVerify = {
  logs: string;
  errorLogs: string;
  exit: 'ok' | 'error' | 'none';
  fallbackLogs: string[];
};

function captureVerify(
  useEngine: boolean,
  args: string[],
  options: { files?: string[] } = {},
  debugFallback = false,
): CapturedVerify {
  vitest.restoreAllMocks();
  process.env['SHERIFF_ENGINE'] = useEngine ? '1' : '0';
  process.env['SHERIFF_ENGINE_DEBUG'] = debugFallback ? '1' : '0';
  const fallbackLogs: string[] = [];
  vitest.spyOn(console, 'error').mockImplementation((message) => {
    fallbackLogs.push(String(message));
  });
  const { allLogs, allErrorLogs, mockedCli } = mockCli();

  verify(args, options);

  return {
    logs: allLogs(),
    errorLogs: allErrorLogs(),
    exit:
      mockedCli.endProcessError.mock.calls.length > 0
        ? 'error'
        : mockedCli.endProcessOk.mock.calls.length > 0
          ? 'ok'
          : 'none',
    fallbackLogs,
  };
}

function createViolationProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'sheriff-engine-verify-'));
  mkdirSync(join(project, 'src/source'), { recursive: true });
  mkdirSync(join(project, 'src/target'), { recursive: true });
  writeFileSync(join(project, 'tsconfig.json'), '{}');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ dependencies: { 'blocked-library': '1.0.0' } }),
  );
  writeFileSync(
    join(project, 'sheriff.config.ts'),
    `export const config = {
      version: 1,
      entryFile: 'src/main.ts',
      modules: {
        'src/source': 'source',
        'src/target': ['target:z', 'target:a'],
      },
      depRules: { root: 'source', source: [], target: '*' },
      externalRules: { source: [] },
    };`,
  );
  writeFileSync(join(project, 'src/main.ts'), `import './source';`);
  writeFileSync(
    join(project, 'src/source/index.ts'),
    `import '../target/internal'; import 'blocked-library';`,
  );
  writeFileSync(join(project, 'src/target/index.ts'), 'export {};');
  writeFileSync(join(project, 'src/target/internal.ts'), 'export {};');
  return project;
}

function createRegExpFallbackProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'sheriff-engine-fallback-'));
  mkdirSync(join(project, 'src/target'), { recursive: true });
  writeFileSync(join(project, 'tsconfig.json'), '{}');
  writeFileSync(
    join(project, 'sheriff.config.ts'),
    `export const config = {
      version: 1,
      entryFile: 'src/main.ts',
      modules: { 'src/target': 'target' },
      depRules: { root: /target/, target: '*' },
    };`,
  );
  writeFileSync(join(project, 'src/main.ts'), `import './target';`);
  writeFileSync(join(project, 'src/target/index.ts'), 'export {};');
  return project;
}

function createInheritedRulesFallbackProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'sheriff-engine-inherited-'));
  mkdirSync(join(project, 'src/source'), { recursive: true });
  mkdirSync(join(project, 'src/target'), { recursive: true });
  writeFileSync(join(project, 'tsconfig.json'), '{}');
  writeFileSync(
    join(project, 'sheriff.config.ts'),
    `const inherited = { '*': 'target' };
    const denyRules = Object.assign(Object.create(inherited), {
      unused: 'never',
    });
    export const config = {
      version: 1,
      entryFile: 'src/main.ts',
      modules: { 'src/source': 'source', 'src/target': 'target' },
      depRules: { root: 'source', source: 'target', target: '*' },
      denyRules,
    };`,
  );
  writeFileSync(join(project, 'src/main.ts'), `import './source';`);
  writeFileSync(join(project, 'src/source/index.ts'), `import '../target';`);
  writeFileSync(join(project, 'src/target/index.ts'), 'export {};');
  return project;
}

function createMutatingCallbackFallbackProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'sheriff-engine-mutating-'));
  mkdirSync(join(project, 'src/source'), { recursive: true });
  mkdirSync(join(project, 'src/target'), { recursive: true });
  writeFileSync(join(project, 'tsconfig.json'), '{}');
  writeFileSync(
    join(project, 'sheriff.config.ts'),
    `export const config = {
      version: 1,
      entryFile: 'src/main.ts',
      modules: {
        'src/source': 'source',
        'src/target': ['target:z', 'target:m', 'target:a'],
      },
      depRules: {
        root: 'source',
        source: ({ toTags }) => (toTags.reverse(), false),
        target: '*',
      },
    };`,
  );
  writeFileSync(join(project, 'src/main.ts'), `import './source';`);
  writeFileSync(join(project, 'src/source/index.ts'), `import '../target';`);
  writeFileSync(join(project, 'src/target/index.ts'), 'export {};');
  return project;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
