import type {
  EngineErrorOutput,
  EngineFile,
  EngineOutput,
  ProjectHandle,
  ProjectHandleInput,
} from '@lambda-solutions/sheriff-engine';
import { getPlugins } from '../cli/internal/get-plugins';
import { buildEngineProjectInput } from '../engine/build-engine-project-input';
import {
  loadEnginePackage,
  logEngineFallback,
} from '../engine/run-engine-project';
import { isRelativeImport } from '../eslint/is-relative-import';
import { FsPath, toFsPath } from '../file-info/fs-path';
import getFs from '../fs/getFs';
import { init, ProjectInfo } from '../main/init';
import { calcTagsForModule } from '../tags/calc-tags-for-module';

export type DaemonLintResult = {
  dependencyRuleViolations: Array<{
    fromTag: string;
    toTags: string[];
    rawImport: string;
  }>;
  encapsulationViolations: string[];
  externalRuleViolations: Array<{
    fromTag: string;
    externalLibrary: string;
  }>;
  unresolvableImports: string[];
};

type ProjectHandleLike = Pick<
  ProjectHandle,
  'clearOverlay' | 'getReachedFiles' | 'getResult' | 'setOverlay'
>;

export type EngineLintHostDependencies = {
  createHandle?: (input: ProjectHandleInput) => ProjectHandleLike;
  getConfig?: typeof getDaemonConfig;
  initialize?: typeof init;
};

type HostedHandle = {
  handle: ProjectHandleLike;
  projectInfo: ProjectInfo;
  reachedFiles: Set<string>;
  dependencyStamps: DependencyStamp[];
};

type DependencyStamp = { path: FsPath; lastModified: number };

type HostState =
  | { kind: 'cold' }
  | { kind: 'ready'; handles: Map<string, HostedHandle> }
  | { kind: 'failedUntilInvalidate' }
  | { kind: 'permanentlyDisabled' };

/**
 * Hosts one persistent native ProjectHandle per configured entry point.
 * Watcher invalidation drops every handle, and each request also validates
 * dependency mtimes before reusing a ready handle. Rebuilds always start from
 * complete `traverse: true` project data.
 */
export function createEngineLintHost(
  rootDir: string,
  dependencies: EngineLintHostDependencies = {},
): {
  invalidate: () => void;
  lintFileViaEngine: (
    filename: string,
    fileContent?: string,
  ) => DaemonLintResult | undefined;
} {
  const createHandle =
    dependencies.createHandle ??
    ((input: ProjectHandleInput) =>
      new (loadEnginePackage().ProjectHandle)(input));
  const getConfig = dependencies.getConfig ?? getDaemonConfig;
  const initialize = dependencies.initialize ?? init;
  let state: HostState = { kind: 'cold' };

  const discardHandles = () => {
    if (state.kind !== 'permanentlyDisabled') {
      state = { kind: 'cold' };
    }
  };

  return {
    invalidate: discardHandles,
    lintFileViaEngine(filename, fileContent) {
      const handles = getOrBuildHandles();
      if (!handles) {
        return undefined;
      }

      try {
        const absoluteFilename = absoluteFilePath(rootDir, filename);
        const coveringHandles = [...handles.values()].filter(
          ({ reachedFiles }) => reachedFiles.has(absoluteFilename),
        );
        if (coveringHandles.length === 0) {
          logEngineFallback(`file is not reached: ${absoluteFilename}`);
          return undefined;
        }

        const results = coveringHandles.map((hosted) =>
          lintCoveredFile(hosted, absoluteFilename, fileContent),
        );
        if (results.some((result) => result === undefined)) {
          return undefined;
        }
        const [first, ...rest] = results as DaemonLintResult[];
        if (rest.some((result) => !sameLintResult(first, result))) {
          logEngineFallback(
            `covering entry handles disagree for ${absoluteFilename}`,
          );
          return undefined;
        }
        return first;
      } catch (error) {
        logEngineFallback(error);
        return undefined;
      }
    },
  };

  function getOrBuildHandles(): Map<string, HostedHandle> | undefined {
    if (
      state.kind === 'permanentlyDisabled' ||
      state.kind === 'failedUntilInvalidate'
    ) {
      return undefined;
    }
    if (state.kind === 'ready') {
      if (areHandlesFresh(state.handles)) {
        return state.handles;
      }
      state = { kind: 'cold' };
    }

    try {
      const config = getConfig();
      if (!config) {
        throw new Error('sheriff.config.ts not found');
      }
      const entries =
        config.entryPoints ??
        (config.entryFile ? { default: config.entryFile } : undefined);
      if (!entries || Object.keys(entries).length === 0) {
        throw new Error('no configured Sheriff entry points');
      }

      const handles = new Map(
        Object.entries(entries).map(([entry, entryFile]) => {
          const absoluteEntryFile = absoluteFilePath(rootDir, entryFile);
          const projectInfo = initialize(toFsPath(absoluteEntryFile), {
            traverse: true,
          });
          const handle = createHandle(
            buildEngineProjectInput(projectInfo, absoluteEntryFile),
          );
          parseEngineOutput(handle.getResult());
          const reachedFiles = parseReachedFiles(
            handle.getReachedFiles(),
            projectInfo.rootDir,
          );
          const dependencyStamps = createDependencyStamps(
            rootDir,
            projectInfo,
            reachedFiles,
          );
          return [
            entry,
            { handle, projectInfo, reachedFiles, dependencyStamps },
          ] as const;
        }),
      );

      state = { kind: 'ready', handles };
      return handles;
    } catch (error) {
      state = {
        kind: isPermanentBuildFailure(error)
          ? 'permanentlyDisabled'
          : 'failedUntilInvalidate',
      };
      logEngineFallback(error);
      return undefined;
    }
  }

  function lintCoveredFile(
    hosted: HostedHandle,
    absoluteFilename: string,
    fileContent: string | undefined,
  ): DaemonLintResult | undefined {
    let result: DaemonLintResult | undefined;
    let requestError: unknown;
    const hasOverlay = fileContent !== undefined;

    try {
      if (hasOverlay) {
        parseEngineOutput(
          hosted.handle.setOverlay(absoluteFilename, fileContent),
        );
      }
      const output = parseEngineOutput(hosted.handle.getResult());
      result = createLintResult(output, absoluteFilename, hosted.projectInfo);
    } catch (error) {
      requestError = error;
    } finally {
      if (hasOverlay) {
        try {
          parseEngineOutput(hosted.handle.clearOverlay(absoluteFilename));
        } catch (error) {
          // A handle whose overlay could not be cleared must never be reused.
          discardHandles();
          requestError ??= error;
        }
      }
    }

    if (requestError !== undefined) {
      logEngineFallback(requestError);
      return undefined;
    }
    return result;
  }
}

function getDaemonConfig() {
  return getPlugins().config;
}

function absoluteFilePath(rootDir: string, filename: string): FsPath {
  const fs = getFs();
  const absolutePath = fs.isAbsolute(filename)
    ? filename
    : fs.join(rootDir, filename);
  return toFsPath(absolutePath);
}

function parseReachedFiles(serialized: string, rootDir: FsPath): Set<string> {
  const parsed = parseEngineJson(serialized);
  if (!Array.isArray(parsed['files'])) {
    throw new Error('engine reached-file output has no files array');
  }

  return new Set(
    parsed['files'].map((file) => {
      if (typeof file !== 'string') {
        throw new Error(
          'engine reached-file output contains a non-string path',
        );
      }
      // ProjectHandle exposes paths relative to its tsconfig root.
      return absoluteFilePath(rootDir, file);
    }),
  );
}

function createDependencyStamps(
  daemonRootDir: string,
  projectInfo: ProjectInfo,
  reachedFiles: Set<string>,
): DependencyStamp[] {
  const fs = getFs();
  const rootConfigPath = fs.join(daemonRootDir, 'sheriff.config.ts');
  const projectRootConfigPath = fs.join(
    projectInfo.rootDir,
    'sheriff.config.ts',
  );
  const paths = new Set<FsPath>([
    ...[...reachedFiles].map((path) => path as FsPath),
    ...projectInfo.tsData.sourceConfigPaths,
    ...(projectInfo.configFilePath ? [projectInfo.configFilePath] : []),
    rootConfigPath as FsPath,
    projectRootConfigPath as FsPath,
  ]);

  return [...paths].map((path) => ({
    path,
    lastModified: safeLastModified(path),
  }));
}

function areHandlesFresh(handles: Map<string, HostedHandle>): boolean {
  try {
    return [...handles.values()].every(({ dependencyStamps }) =>
      dependencyStamps.every(
        ({ path, lastModified }) => getFs().lastModified(path) === lastModified,
      ),
    );
  } catch {
    // A dependency vanished between requests.
    return false;
  }
}

function safeLastModified(path: FsPath): number {
  try {
    return getFs().lastModified(path);
  } catch {
    // `NaN` never compares equal, matching project-cache dependency stamps.
    return NaN;
  }
}

function parseEngineOutput(serialized: string): EngineOutput {
  const parsed = parseEngineJson(serialized);
  if (
    !Array.isArray(parsed['files']) ||
    !Array.isArray(parsed['modules']) ||
    parsed['violations'] === null ||
    typeof parsed['violations'] !== 'object'
  ) {
    throw new Error('engine returned a malformed project result');
  }
  return parsed as unknown as EngineOutput;
}

function parseEngineJson(serialized: string): Record<string, unknown> {
  const parsed = JSON.parse(serialized) as unknown;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('engine returned a non-object result');
  }
  if ('error' in parsed) {
    const error = (parsed as EngineErrorOutput).error;
    throw Object.assign(new Error(`${error.code}: ${error.message}`), {
      code: error.code,
    });
  }
  return parsed as Record<string, unknown>;
}

function isPermanentBuildFailure(error: unknown): boolean {
  const code =
    error instanceof Error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  return (
    typeof code === 'string' &&
    [
      'SHERIFF_ENGINE_PACKAGE_MISSING',
      'SHERIFF_ENGINE_NATIVE_MISSING',
      'SHERIFF_ENGINE_NATIVE_LOAD_FAILED',
      'SHERIFF_ENGINE_UNSUPPORTED_CONFIG',
      'SHERIFF_ENGINE_IMPURE_CALLBACK',
    ].includes(code)
  );
}

function sameLintResult(
  left: DaemonLintResult,
  right: DaemonLintResult,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createLintResult(
  output: EngineOutput,
  absoluteFilename: string,
  projectInfo: ProjectInfo,
): DaemonLintResult {
  const engineFilename = relativeEnginePath(
    projectInfo.rootDir,
    absoluteFilename,
  );
  const file = output.files.find(({ path }) => path === engineFilename);
  if (!file) {
    throw new Error(`engine result omitted reached file ${engineFilename}`);
  }

  const dependency = output.violations.dependency.filter(
    (violation) => violation.file === engineFilename,
  );
  const encapsulation = output.violations.encapsulation.filter(
    (violation) => violation.file === engineFilename,
  );
  const external = output.violations.external.filter(
    (violation) => violation.file === engineFilename,
  );

  return {
    dependencyRuleViolations: orderByImports(
      dependency,
      file,
      'module',
      (violation, importInfo) =>
        violation.rawImport === importInfo.raw &&
        (importInfo.resolvedPath === undefined ||
          violation.toFilePath === importInfo.resolvedPath),
    ).map((violation) => ({
      fromTag: violation.fromTag,
      toTags: compatibleTypeScriptTagOrder(violation, projectInfo),
      rawImport: violation.rawImport,
    })),
    encapsulationViolations: deduplicate(
      orderByImports(
        encapsulation,
        file,
        'module',
        (violation, importInfo) =>
          violation.rawImport === importInfo.raw &&
          (importInfo.resolvedPath === undefined ||
            violation.toFilePath === importInfo.resolvedPath),
      ).map(({ rawImport }) => rawImport),
    ),
    externalRuleViolations: orderByImports(
      external,
      file,
      'external',
      (violation, importInfo) => violation.externalLibrary === importInfo.raw,
    ).map(({ fromTag, externalLibrary }) => ({ fromTag, externalLibrary })),
    unresolvableImports: file.imports
      .filter(
        (importInfo) =>
          importInfo.kind === 'unresolvable' &&
          isRelativeImport(importInfo.raw),
      )
      .map(({ raw }) => raw),
  };
}

function orderByImports<Violation>(
  violations: Violation[],
  file: EngineFile,
  kind: EngineFile['imports'][number]['kind'],
  matches: (
    violation: Violation,
    importInfo: EngineFile['imports'][number],
  ) => boolean,
): Violation[] {
  const remaining = [...violations];
  const ordered: Violation[] = [];
  for (const importInfo of file.imports) {
    if (importInfo.kind !== kind) {
      continue;
    }
    const index = remaining.findIndex((violation) =>
      matches(violation, importInfo),
    );
    if (index !== -1) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }
  if (remaining.length > 0) {
    throw new Error('engine returned an unmappable lint violation');
  }
  return ordered;
}

function compatibleTypeScriptTagOrder(
  violation: EngineOutput['violations']['dependency'][number],
  projectInfo: ProjectInfo,
): string[] {
  const modulePath = toFsPath(
    violation.toModulePath === '.'
      ? projectInfo.rootDir
      : getFs().join(projectInfo.rootDir, violation.toModulePath),
  );
  const tags = calcTagsForModule(
    modulePath,
    projectInfo.rootDir,
    projectInfo.config.modules,
    projectInfo.config.autoTagging,
  );
  if (!haveSameValues(tags, violation.toTags)) {
    throw new Error(
      `engine returned incompatible tags for module ${violation.toModulePath}`,
    );
  }
  return tags;
}

function haveSameValues(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function deduplicate(values: string[]): string[] {
  return [...new Set(values)];
}

function relativeEnginePath(rootDir: FsPath, path: string): string {
  return (getFs().relativeTo(rootDir, path) || '.').replaceAll('\\', '/');
}
