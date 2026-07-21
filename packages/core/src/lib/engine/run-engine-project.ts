import type {
  EngineErrorOutput,
  EngineOutput,
  ProjectHandle,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';

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

function loadEnginePackage(): typeof import('@lambda-solutions/sheriff-engine') {
  // Keep the optional package out of the default CLI module-load path. This
  // require runs only after SHERIFF_ENGINE=1 entered the guarded attempt.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@lambda-solutions/sheriff-engine') as typeof import('@lambda-solutions/sheriff-engine');
  } catch (error) {
    if (!isMissingEnginePackage(error)) {
      throw error;
    }

    // The source worktree does not install its own private workspace package.
    // This path has the same public entrypoint and is absent from a core-only
    // published build, where the outer fallback catches that absence too.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../../../sheriff-engine') as typeof import('@lambda-solutions/sheriff-engine');
  }
}

function isMissingEnginePackage(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'MODULE_NOT_FOUND' &&
    error.message.includes("'@lambda-solutions/sheriff-engine'")
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
