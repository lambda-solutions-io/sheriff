import {
  isModuleDefinition,
  MatcherContext,
  ModuleConfig,
  ModuleDefinition,
  TagConfigValue,
} from '../config/module-config';
import getFs from '../fs/getFs';
import { FsPath } from '../file-info/fs-path';
import {
  ExistingTagPlaceholderError,
  InvalidPlaceholderError,
  NoAssignedTagError,
  TagWithoutValueError,
} from '../error/user-error';

// A folder wildcard matches any character except the path separator
// (segments are matched individually), mirroring the `[^/]*` semantics
// of file patterns. Keeps digits and dots matching, e.g. `feat-v2` (#46).
export const FOLDER_CHARACTERS_REGEX_STRING = '[^/]';
export const PLACE_HOLDER_REGEX = /<[a-zA-Z0-9_-]+>/g;

export const calcTagsForModule = (
  moduleDir: FsPath,
  rootDir: FsPath,
  moduleConfig: ModuleConfig,
  autoTagging = true,
): string[] => {
  if (moduleDir === rootDir) {
    return ['root'];
  }
  const fs = getFs();
  const paths = fs.split(moduleDir.slice(rootDir.length + 1));
  const placeholders: Record<string, string> = {};

  const tags = traverseModuleConfig(
    paths,
    moduleConfig,
    placeholders,
    moduleDir,
    [],
    true,
  );

  if (tags === false) {
    if (!autoTagging) {
      throw new NoAssignedTagError(moduleDir);
    }

    return ['noTag'];
  }

  return tags;
};

function traverseModuleConfig(
  paths: string[],
  tagConfig: ModuleConfig,
  placeholders: Record<string, string>,
  moduleDir: string,
  tagConfigPath: string[],
  isRoot: boolean,
): string[] | false {
  for (const pathMatcher in tagConfig) {
    if (isRoot) {
      placeholders = {};
    }
    // might be reset below
    const originalPlaceholders = { ...placeholders };

    // a `**` segment spans zero or more path segments and therefore needs
    // its own matching with variable spans and backtracking
    if (
      !isRegularExpression(pathMatcher) &&
      pathMatcher.split('/').includes('**')
    ) {
      const result = traverseRecursiveGlobKey(
        pathMatcher,
        paths,
        placeholders,
        tagConfig[pathMatcher],
        moduleDir,
        tagConfigPath,
      );
      if (result !== false) {
        return result;
      }
      continue;
    }

    const { matcherContext, matches, pathFragmentSpan } = matchSegment(
      pathMatcher,
      paths,
      placeholders,
    );

    if (!matches) {
      continue;
    }

    const restPaths = paths.slice(pathFragmentSpan);

    const value = tagConfig[pathMatcher];
    if (restPaths.length === 0) {
      assertLeafHasTag(value, [...tagConfigPath, pathMatcher]);
      const tagProperty = isModuleDefinition(value) ? value.tags : value;
      if (typeof tagProperty === 'function') {
        return addToTags(
          tagProperty(placeholders, matcherContext),
          placeholders,
          moduleDir,
        );
      } else {
        return addToTags(tagProperty, placeholders, moduleDir);
      }
    } else {
      if (isModuleLeafValue(value)) {
        /**
         * Nested Module use case. Example:
         *
         * tags requested for moduleDir libs/src/holiday/data
         *
         * TagConfig:
         * {
         *   'libs/<domain>/src': 'nx-lib', // <-- we are here!
         *   'libs/<domain>/src/data': ['domain:<domain>']
         * }
         */
        placeholders = originalPlaceholders;
        continue;
      }

      return traverseModuleConfig(
        restPaths,
        value,
        placeholders,
        moduleDir,
        [...tagConfigPath, pathMatcher],
        false,
      );
    }
  }

  return false;
}

/**
 * Matches a key containing `**` against the module path. Spans are tried
 * shortest-first with backtracking: a longer `**` span is only used when
 * the rest of the matcher (and any nested config behind it) cannot be
 * satisfied otherwise. `**` never captures a placeholder.
 *
 * Unlike fixed-span keys, a nested config that is reached with no path
 * segments left is not an error here - the `**` legitimately covers the
 * intermediate directories - and an exhausted key falls through to the
 * next one instead of ending the traversal.
 */
function traverseRecursiveGlobKey(
  pathMatcher: string,
  paths: string[],
  placeholders: Record<string, string>,
  value: TagConfigValue | ModuleDefinition | ModuleConfig,
  moduleDir: string,
  tagConfigPath: string[],
): string[] | false {
  const matcherSegments = pathMatcher.split('/');
  const minSpan = matcherSegments.filter(
    (segment) => segment !== '**',
  ).length;

  for (let span = minSpan; span <= paths.length; span++) {
    const trialPlaceholders = { ...placeholders };
    if (
      !matchesWithRecursiveGlobs(
        matcherSegments,
        paths.slice(0, span),
        trialPlaceholders,
      )
    ) {
      continue;
    }

    const restPaths = paths.slice(span);
    if (restPaths.length === 0) {
      if (!isModuleLeafValue(value)) {
        continue;
      }
      const tagProperty = isModuleDefinition(value) ? value.tags : value;
      if (typeof tagProperty === 'function') {
        const matcherContext: MatcherContext = {
          segment: paths.slice(0, span).join('/'),
        };
        return addToTags(
          tagProperty(trialPlaceholders, matcherContext),
          trialPlaceholders,
          moduleDir,
        );
      }
      return addToTags(tagProperty, trialPlaceholders, moduleDir);
    }

    if (isModuleLeafValue(value)) {
      // a longer span may still consume the remaining segments
      continue;
    }

    const result = traverseModuleConfig(
      restPaths,
      value,
      trialPlaceholders,
      moduleDir,
      [...tagConfigPath, pathMatcher],
      false,
    );
    if (result !== false) {
      return result;
    }
  }

  return false;
}

/**
 * Segment-wise matching where `**` consumes zero or more path segments
 * (shortest first). Placeholders captured by a failed branch are rolled
 * back, so backtracking cannot trip the duplicate-placeholder guard.
 */
function matchesWithRecursiveGlobs(
  matcherSegments: string[],
  pathSegments: string[],
  placeholders: Record<string, string>,
): boolean {
  if (matcherSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [matcherSegment, ...remainingMatchers] = matcherSegments;

  if (matcherSegment === '**') {
    for (let skipped = 0; skipped <= pathSegments.length; skipped++) {
      if (
        matchesWithRecursiveGlobs(
          remainingMatchers,
          pathSegments.slice(skipped),
          placeholders,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  if (pathSegments.length === 0) {
    return false;
  }

  const captured: string[] = [];
  if (
    !matchesSingleSegment(
      matcherSegment,
      pathSegments[0],
      placeholders,
      captured,
    )
  ) {
    return false;
  }
  if (
    matchesWithRecursiveGlobs(
      remainingMatchers,
      pathSegments.slice(1),
      placeholders,
    )
  ) {
    return true;
  }
  for (const name of captured) {
    delete placeholders[name];
  }
  return false;
}

function matchesSingleSegment(
  matcherSegment: string,
  pathSegment: string,
  placeholders: Record<string, string>,
  captured: string[],
): boolean {
  const placeholderNames = (
    matcherSegment.match(PLACE_HOLDER_REGEX) ?? []
  ).map((name) => name.slice(1, name.length - 1));

  if (placeholderNames.length === 0) {
    if (matcherSegment === pathSegment) {
      return true;
    }
    if (matcherSegment.includes('*')) {
      return matchesWildcardFragment(matcherSegment, pathSegment);
    }
    return false;
  }

  const segmentRegex = new RegExp(
    '^' +
      matcherSegment
        .split(PLACE_HOLDER_REGEX)
        .map(escapeRegExpKeepingWildcards)
        .join('([^/]+)') +
      '$',
  );
  const match = pathSegment.match(segmentRegex);
  if (!match) {
    return false;
  }

  placeholderNames.forEach((name, ix) => {
    if (name in placeholders) {
      throw new ExistingTagPlaceholderError(name);
    }
    placeholders[name] = match[ix + 1];
    captured.push(name);
  });
  return true;
}

function isModuleLeafValue(
  value: TagConfigValue | ModuleDefinition | ModuleConfig,
): value is TagConfigValue | ModuleDefinition {
  return (
    isModuleDefinition(value) ||
    !(typeof value === 'object' && !Array.isArray(value))
  );
}

function assertLeafHasTag(
  value: TagConfigValue | ModuleDefinition | ModuleConfig,
  tagConfigPath: string[],
): asserts value is TagConfigValue | ModuleDefinition {
  if (!isModuleLeafValue(value)) {
    throw new TagWithoutValueError(tagConfigPath.join('/'));
  }
}

function addToTags(
  newTags: string | string[],
  placeholders: Record<string, string>,
  moduleDir: string,
) {
  return (Array.isArray(newTags) ? newTags : [newTags]).map((tag) =>
    replacePlaceholdersInTag(tag, placeholders, moduleDir),
  );
}

function replacePlaceholdersInTag(
  tag: string,
  placeholders: Record<string, string>,
  fullDir: string,
) {
  let replacedTag = tag;
  for (const placeholder in placeholders) {
    const value = placeholders[placeholder];
    replacedTag = replacedTag.replace(
      new RegExp(`<${placeholder}>`, 'g'),
      value,
    );
  }

  const unavailablePlaceholder = replacedTag.match(PLACE_HOLDER_REGEX);
  if (unavailablePlaceholder) {
    throw new InvalidPlaceholderError(unavailablePlaceholder[0], fullDir);
  }

  return replacedTag;
}

function isRegularExpression(segment: string) {
  return segment.startsWith('/') && segment.endsWith('/');
}

function escapeRegExp(literal: string) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// module discovery matches `*` via matchesFolderSegmentPattern; tagging has
// to agree, otherwise a wildcard-defined module exists but carries 'noTag'
function escapeRegExpKeepingWildcards(literal: string) {
  return literal
    .split('*')
    .map(escapeRegExp)
    .join(`${FOLDER_CHARACTERS_REGEX_STRING}*`);
}

function matchesWildcardFragment(matcher: string, pathFragment: string) {
  const regex = new RegExp(`^${escapeRegExpKeepingWildcards(matcher)}$`);
  return regex.test(pathFragment);
}

function handlePlaceholderMatching(
  pathMatcher: string,
  currentPath: string,
  placeholderMatch: string[],
  placeholders: Record<string, string>,
) {
  // literal parts must not act as regex syntax (except `*`, which keeps its
  // single-segment wildcard meaning); anchor to match the full path;
  // a placeholder matches within a single segment and never crosses a `/`
  const placeholderRegex =
    '^' +
    pathMatcher
      .split(PLACE_HOLDER_REGEX)
      .map(escapeRegExpKeepingWildcards)
      .join('([^/]+)') +
    '$';
  const pathMatch = currentPath.match(new RegExp(placeholderRegex));
  if (!pathMatch) {
    return false;
  }

  placeholderMatch.forEach((placeholder, ix) => {
    if (placeholder in placeholders) {
      throw new ExistingTagPlaceholderError(placeholder);
    }
    placeholders[placeholder] = pathMatch[ix + 1];
  });
  return true;
}

function handleRegularExpression(
  paths: string[],
  segment: string,
): RegExpMatchArray | null {
  const currentPath = paths[0];
  const regExpString = segment.substring(1, segment.length - 1);
  const regExp = new RegExp(regExpString);
  const match = currentPath.match(regExp);
  return match && match[0] === currentPath ? match : null;
}

function matchSegment(
  segmentMatcher: string,
  paths: string[],
  placeholders: Record<string, string>,
) {
  let matches = true;
  let pathFragment = paths[0];
  const matcherContext: MatcherContext = { segment: pathFragment };
  let pathFragmentSpan = 1;

  if (isRegularExpression(segmentMatcher)) {
    const regExpMatchArray = handleRegularExpression(paths, segmentMatcher);
    if (regExpMatchArray) {
      matcherContext.regexMatch = regExpMatchArray;
    } else {
      matches = false;
    }
  } else {
    pathFragmentSpan = segmentMatcher.split('/').length;
    if (pathFragmentSpan > paths.length) {
      matches = false;
    }
    pathFragment = paths.slice(0, pathFragmentSpan).join('/');
    const placeholderMatch = (segmentMatcher.match(PLACE_HOLDER_REGEX) ?? []).map(
      (str) => str.slice(1, str.length - 1),
    );
    if (placeholderMatch.length) {
      matches = handlePlaceholderMatching(
        segmentMatcher,
        pathFragment,
        placeholderMatch,
        placeholders,
      );
    } else if (segmentMatcher.includes('*')) {
      matches = matchesWildcardFragment(segmentMatcher, pathFragment);
    } else {
      if (segmentMatcher !== pathFragment) {
        matches = false;
      }
    }
  }
  return {
    pathFragment,
    pathFragmentSpan,
    matches,
    matcherContext,
  };
}
