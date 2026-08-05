import { ModuleConfig } from '../../config/module-config';
import { FsPath } from '../../file-info/fs-path';
import getFs from '../../fs/getFs';
import { flattenModules } from './flatten-modules';
import {
  hasSourceFileExtension,
  matchesFolderSegmentPattern,
} from './segment-pattern';

/**
 * A pattern being partially matched during the traversal: `index` points to
 * the next segment of `segments` to match. Several states can be active for
 * the same directory (overlapping patterns, issue #56; `**` spans).
 */
interface PatternState {
  patternId: number;
  segments: string[];
  index: number;
}

/**
 * Module paths discovered from the `modules` configuration: directories as
 * before, plus single-file modules from keys whose last segment names a
 * source-file extension.
 */
export interface ConfiguredModulePaths {
  directories: Set<FsPath>;
  files: Set<FsPath>;
}

/**
 * The current criterion for finding modules is via
 * the SheriffConfig's property `modules`.
 *
 * We will traverse the filesystem and match directories
 * against the patterns. A `**` segment matches zero or more directory
 * segments; all other segments keep single-segment semantics.
 *
 * @param includeDirectoriesWithBarrel Whether a matched directory which
 * contains the barrel file is returned as well. With
 * `moduleIdentity: 'auto'` it is `false`: such directories are picked up by
 * `findModulePathsWithBarrel`, the sole source of barrel modules in that
 * mode. With `moduleIdentity: 'config'` it is `true`: the `modules`
 * configuration is the only source of module identity, so a barrel file must
 * not drop a configured directory from the result.
 */
export function findModulePathsWithoutBarrel(
  moduleConfig: ModuleConfig,
  rootDir: FsPath,
  barrelFileName: string,
  includeDirectoriesWithBarrel = false,
): ConfiguredModulePaths {
  const initialStates = epsilonClosure(
    flattenModules(moduleConfig, '').map((pattern, patternId) => ({
      patternId,
      segments: pattern.split('/'),
      index: 0,
    })),
  );

  const matchedDirectories: FsPath[] = [];
  const matchedFiles: FsPath[] = [];
  traverseAndMatch(
    initialStates,
    rootDir,
    barrelFileName,
    includeDirectoriesWithBarrel,
    matchedDirectories,
    matchedFiles,
  );
  return {
    directories: new Set<FsPath>(matchedDirectories),
    files: new Set<FsPath>(matchedFiles),
  };
}

/**
 * Recursively traverse the filesystem, keeping the set of active pattern
 * states per directory. Every matching pattern is followed: descending into
 * only the first match silently loses sibling patterns and their modules
 * (issue #56). Duplicate matches collapse into a single module because a
 * directory is visited exactly once.
 */
function traverseAndMatch(
  states: PatternState[],
  basePath: FsPath,
  barrelFileName: string,
  includeDirectoriesWithBarrel: boolean,
  matchedDirectories: FsPath[],
  matchedFiles: FsPath[],
): void {
  const fs = getFs();

  if (states.some((state) => state.index === state.segments.length)) {
    addAsModule(
      matchedDirectories,
      basePath,
      barrelFileName,
      includeDirectoriesWithBarrel,
    );
  }

  const subDirectories = fs.readDirectory(basePath, 'directory');

  const fileMatchers = states
    .filter(isOnFileSegment)
    .map((state) => state.segments[state.index]);
  if (fileMatchers.length > 0) {
    const subDirectorySet = new Set<string>(subDirectories);
    for (const child of fs.readDirectory(basePath, 'none')) {
      if (subDirectorySet.has(child)) {
        continue;
      }
      const fileName = fs.relativeTo(basePath, child);
      if (
        fileMatchers.some((matcher) =>
          matchesFolderSegmentPattern(matcher, fileName),
        )
      ) {
        matchedFiles.push(child);
      }
    }
  }

  for (const subDirectory of subDirectories) {
    const currentSegment = fs.relativeTo(basePath, subDirectory);
    const nextStates = epsilonClosure(
      advanceStates(states, currentSegment),
    );

    if (nextStates.length > 0) {
      traverseAndMatch(
        nextStates,
        subDirectory,
        barrelFileName,
        includeDirectoriesWithBarrel,
        matchedDirectories,
        matchedFiles,
      );
    }
  }
}

/**
 * Whether the state's next segment is the key's last one and names a
 * source-file extension - the shape that defines single-file modules.
 */
function isOnFileSegment(state: PatternState): boolean {
  return (
    state.index === state.segments.length - 1 &&
    hasSourceFileExtension(state.segments[state.index])
  );
}

function advanceStates(
  states: PatternState[],
  currentSegment: string,
): PatternState[] {
  const nextStates: PatternState[] = [];

  for (const state of states) {
    const patternSegment = state.segments[state.index];
    if (patternSegment === undefined) {
      continue;
    }

    if (isOnFileSegment(state)) {
      // a file-defining segment never matches a directory, so a
      // pathological directory named like a file cannot become a module
      continue;
    }

    if (patternSegment === '**') {
      // self-loop: `**` consumes the segment and stays active. Purely
      // `**`-driven visits skip node_modules and dot-directories - the
      // exact segment count used to make such visits impossible, and a
      // bare 'src/**' must not turn node_modules into modules. Explicit
      // segments (the else branch) still match them.
      if (!isSkippedByRecursiveGlob(currentSegment)) {
        nextStates.push(state);
      }
    } else if (matchesFolderSegmentPattern(patternSegment, currentSegment)) {
      nextStates.push({ ...state, index: state.index + 1 });
    }
  }

  return nextStates;
}

/**
 * `**` matches zero or more segments: every state standing on a `**` also
 * activates the state behind it. Consecutive `**` segments collapse through
 * repeated application.
 */
function epsilonClosure(states: PatternState[]): PatternState[] {
  const closure: PatternState[] = [];
  const seen = new Set<string>();

  const add = (state: PatternState) => {
    const key = `${state.patternId}:${state.index}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    closure.push(state);
    if (state.segments[state.index] === '**') {
      add({ ...state, index: state.index + 1 });
    }
  };

  states.forEach(add);
  return closure;
}

function isSkippedByRecursiveGlob(segment: string): boolean {
  return segment === 'node_modules' || segment.startsWith('.');
}

function addAsModule(
  modulePaths: FsPath[],
  directory: FsPath,
  barrelFileName: string,
  includeDirectoriesWithBarrel: boolean,
) {
  const fs = getFs();

  if (
    !includeDirectoriesWithBarrel &&
    // exact-case probe: `findModulePathsWithBarrel` discovers barrels
    // case-sensitively, so a case-variant file must not drop the
    // directory here - the module would vanish entirely (issue #70)
    fs.existsCaseSensitive(fs.join(directory, barrelFileName))
  ) {
    return;
  }

  modulePaths.push(directory);
}
