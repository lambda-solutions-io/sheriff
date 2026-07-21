import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { resolve } from 'node:path';
import { clearProjectCache } from '../../cache/project-cache';
import { useDefaultFs } from '../../fs/getFs';
import { mockCli } from './helpers/mock-cli';

const moduleMocks = vitest.hoisted(() => ({
  init: vitest.fn(),
  loadEnginePackage: vitest.fn(),
  actualLoadEnginePackage: undefined as undefined | (() => unknown),
}));

vitest.mock('../../main/init', async (importActual) => {
  const actual = await importActual<typeof import('../../main/init')>();
  moduleMocks.init.mockImplementation(actual.init);
  return { ...actual, init: moduleMocks.init };
});

vitest.mock('../../engine/run-engine-project', async (importActual) => {
  const actual =
    await importActual<typeof import('../../engine/run-engine-project')>();
  moduleMocks.actualLoadEnginePackage = actual.loadEnginePackage;
  moduleMocks.loadEnginePackage.mockImplementation(actual.loadEnginePackage);
  return { ...actual, loadEnginePackage: moduleMocks.loadEnginePackage };
});

import type {
  EngineModulePath,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';
import { verify } from '../verify';

const workspaceRoot = process.cwd();
const originalEngine = process.env['SHERIFF_ENGINE'];
const originalEngineDebug = process.env['SHERIFF_ENGINE_DEBUG'];

describe('verify Rust engine fast-path traversal', () => {
  beforeEach(() => {
    useDefaultFs();
    clearProjectCache();
    moduleMocks.init.mockClear();
    moduleMocks.loadEnginePackage.mockReset();
    moduleMocks.loadEnginePackage.mockImplementation(
      moduleMocks.actualLoadEnginePackage!,
    );
  });

  afterEach(() => {
    process.chdir(workspaceRoot);
    restoreEnvironment('SHERIFF_ENGINE', originalEngine);
    restoreEnvironment('SHERIFF_ENGINE_DEBUG', originalEngineDebug);
    vitest.restoreAllMocks();
    clearProjectCache();
  });

  it('does not initialize the TypeScript project on the native fast path', () => {
    process.chdir(resolve(workspaceRoot, 'test-projects/typescript-i'));

    const result = captureVerify(true);

    expect(result.fallbackLogs).toEqual([]);
    expect(moduleMocks.init).not.toHaveBeenCalled();
  });

  it('falls back to a full TypeScript init when the second phase fails', () => {
    process.chdir(resolve(workspaceRoot, 'test-projects/typescript-i'));
    const typescript = captureVerify(false);
    moduleMocks.init.mockClear();
    const enginePackage =
      moduleMocks.actualLoadEnginePackage!() as typeof import('@lambda-solutions/sheriff-engine');

    class FailingSecondPhaseHandle {
      private readonly handle: InstanceType<typeof enginePackage.ProjectHandle>;

      constructor(input: ProjectHandleInput) {
        this.handle = new enginePackage.ProjectHandle(input);
      }

      getResult(): string {
        return this.handle.getResult();
      }

      getReachedFiles(): string {
        return this.handle.getReachedFiles();
      }

      setModulePaths(_modulePaths: EngineModulePath[]): string {
        throw new Error('forced two-phase failure');
      }
    }

    moduleMocks.loadEnginePackage.mockReturnValue({
      ...enginePackage,
      ProjectHandle: FailingSecondPhaseHandle,
    });
    const engine = captureVerify(true);

    expect(engine.logs).toBe(typescript.logs);
    expect(engine.errorLogs).toBe(typescript.errorLogs);
    expect(engine.exit).toBe(typescript.exit);
    expect(engine.fallbackLogs).toEqual([
      expect.stringContaining('forced two-phase failure'),
    ]);
    expect(moduleMocks.init).toHaveBeenCalledOnce();
  });
});

function captureVerify(useEngine: boolean): {
  logs: string;
  errorLogs: string;
  exit: 'ok' | 'error' | 'none';
  fallbackLogs: string[];
} {
  process.env['SHERIFF_ENGINE'] = useEngine ? '1' : '0';
  process.env['SHERIFF_ENGINE_DEBUG'] = '1';
  const fallbackLogs: string[] = [];
  vitest.spyOn(console, 'error').mockImplementation((message) => {
    fallbackLogs.push(String(message));
  });
  const { allLogs, allErrorLogs, mockedCli } = mockCli();

  verify(['src/main.ts']);

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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
