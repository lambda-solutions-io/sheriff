import type {
  EngineErrorOutput,
  EngineOutput,
  ProjectHandle,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type ProjectHandleLike = Pick<ProjectHandle, 'getResult'>;
type ProjectHandleFactory = (input: ProjectHandleInput) => ProjectHandleLike;

/**
 * Runs one native project analysis. Any native or compatibility failure is a
 * signal to use Sheriff's TypeScript engine for this project.
 */
export function runEngineProject(
  input: ProjectHandleInput,
  createHandle: ProjectHandleFactory = (projectInput) =>
    new (loadEnginePackage().ProjectHandle)(projectInput),
): EngineOutput | undefined {
  try {
    const output = JSON.parse(createHandle(input).getResult()) as
      | EngineOutput
      | EngineErrorOutput;

    if ('error' in output) {
      logEngineFallback(`${output.error.code}: ${output.error.message}`);
      return undefined;
    }

    return output;
  } catch (error) {
    logEngineFallback(error);
    return undefined;
  }
}

type EnginePackage = typeof import('@lambda-solutions/sheriff-engine');
type ModuleLoader = (request: string) => unknown;

const enginePackageName = '@lambda-solutions/sheriff-engine';
const sourceEngineDirectory = resolve(__dirname, '../../../../sheriff-engine');

export function loadEnginePackage(
  loadModule: ModuleLoader = require,
  devEngineDirectory = sourceEngineDirectory,
): EnginePackage {
  // Keep the optional package out of the default CLI module-load path. This
  // require runs only after SHERIFF_ENGINE=1 entered the guarded attempt.
  try {
    return loadModule(enginePackageName) as EnginePackage;
  } catch (error) {
    if (!isMissingEnginePackage(error)) {
      throw error;
    }

    // Development-only fallback: the source worktree does not install its own
    // private workspace package. Verify both workspace manifests before using
    // the absolute sibling path so a compiled CLI cannot load an unrelated
    // module from a coincidentally similar directory.
    if (!isSourceWorktreeEngineDirectory(devEngineDirectory)) {
      throw enginePackageResolutionError(error, devEngineDirectory);
    }

    return loadModule(devEngineDirectory) as EnginePackage;
  }
}

function isMissingEnginePackage(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'MODULE_NOT_FOUND' &&
    error.message.startsWith(`Cannot find module '${enginePackageName}'`)
  );
}

function isSourceWorktreeEngineDirectory(engineDirectory: string): boolean {
  const coreProjectPath = resolve(__dirname, '../../../project.json');
  const expectedEngineDirectory = resolve(
    dirname(coreProjectPath),
    '../sheriff-engine',
  );
  if (resolve(engineDirectory) !== expectedEngineDirectory) {
    return false;
  }

  return (
    hasJsonProperties(coreProjectPath, {
      name: 'core',
      sourceRoot: 'packages/core/src',
    }) &&
    hasJsonProperties(resolve(engineDirectory, 'package.json'), {
      name: enginePackageName,
      private: false,
    }) &&
    existsSync(resolve(engineDirectory, 'index.js'))
  );
}

function hasJsonProperties(
  filePath: string,
  expected: Record<string, unknown>,
): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      unknown
    >;
    return Object.entries(expected).every(
      ([key, value]) => parsed[key] === value,
    );
  } catch {
    return false;
  }
}

function enginePackageResolutionError(
  cause: unknown,
  devEngineDirectory: string,
): Error {
  return Object.assign(
    new Error(
      `Cannot resolve ${enginePackageName}; the source-worktree development ` +
        `fallback is unavailable at ${devEngineDirectory}.`,
      { cause },
    ),
    { code: 'SHERIFF_ENGINE_PACKAGE_MISSING' },
  );
}

export function logEngineFallback(reason: unknown): void {
  if (process.env['SHERIFF_ENGINE_DEBUG'] !== '1') {
    return;
  }

  const message =
    reason instanceof Error
      ? `${getErrorCode(reason)}${reason.message}`
      : String(reason);
  console.error(`[sheriff-engine] Falling back to TypeScript: ${message}`);
}

function getErrorCode(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? `${code}: ` : '';
}
