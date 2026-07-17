import { FOLDER_CHARACTERS_REGEX_STRING } from '../../tags/calc-tags-for-module';

/**
 * Normalize platform-specific separators before comparing config path patterns.
 * VirtualFs is POSIX-only, so Windows coverage has to rely on this explicit
 * normalization at the matching boundaries.
 */
export function normalizePathSeparators(path: string): string {
  return path.replaceAll('\\', '/');
}

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
