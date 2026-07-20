/** Normalize platform-specific separators before comparing paths. */
export function normalizePathSeparators(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Find the final segment boundary in a path that may mix separators. */
export function lastPathSeparatorIndex(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}
