import { FOLDER_CHARACTERS_REGEX_STRING } from '../../tags/calc-tags-for-module';
import { normalizePathSeparators } from '../../util/path-separators';

export { normalizePathSeparators } from '../../util/path-separators';

export function matchesFolderSegmentPattern(
  pattern: string,
  pathSegment: string,
): boolean {
  if (pattern === '*' || pattern === pathSegment) {
    return true;
  }

  if (pattern.includes('*')) {
    const regexPattern = pattern
      .split('*')
      .map(escapeRegex)
      .join(`${FOLDER_CHARACTERS_REGEX_STRING}*`);
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(pathSegment);
  }

  return false;
}

export function matchesFolderPathPattern(
  pattern: string,
  path: string,
): boolean {
  const patternSegments = normalizePathSeparators(pattern).split('/');
  const pathSegments = normalizePathSeparators(path).split('/');

  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every((patternSegment, index) =>
      matchesFolderSegmentPattern(patternSegment, pathSegments[index]),
    )
  );
}

/**
 * Like {@link matchesFolderPathPattern}, but a pattern segment of `**`
 * matches any number of path segments (including none). All other segments
 * keep the single-segment semantics of {@link matchesFolderSegmentPattern}.
 *
 * Leading and trailing separators (`/` or `\`) in the pattern are ignored,
 * so `src/api/` and `/src/api` match the same paths as `src/api`.
 */
export function matchesFolderPathGlob(pattern: string, path: string): boolean {
  const patternSegments = normalizePathSeparators(pattern)
    .replace(/^\/+|\/+$/g, '')
    .split('/');
  const pathSegments = normalizePathSeparators(path).split('/');

  return matchesSegments(patternSegments, pathSegments);
}

function matchesSegments(
  patternSegments: string[],
  pathSegments: string[],
): boolean {
  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [patternSegment, ...remainingPatternSegments] = patternSegments;

  if (patternSegment === '**') {
    for (let skipped = 0; skipped <= pathSegments.length; skipped++) {
      if (
        matchesSegments(remainingPatternSegments, pathSegments.slice(skipped))
      ) {
        return true;
      }
    }
    return false;
  }

  return (
    pathSegments.length > 0 &&
    matchesFolderSegmentPattern(patternSegment, pathSegments[0]) &&
    matchesSegments(remainingPatternSegments, pathSegments.slice(1))
  );
}

export function matchesFilePathPattern(pattern: string, path: string): boolean {
  const patternSegments = normalizePathSeparators(pattern).split('/');
  const pathSegments = normalizePathSeparators(path).split('/');

  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every((patternSegment, index) =>
      matchesFileSegmentPattern(patternSegment, pathSegments[index]),
    )
  );
}

function matchesFileSegmentPattern(
  pattern: string,
  pathSegment: string,
): boolean {
  if (pattern === '*' || pattern === pathSegment) {
    return true;
  }

  if (pattern.includes('*')) {
    const regexPattern = pattern.split('*').map(escapeRegex).join('[^/]*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(pathSegment);
  }

  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1');
}
