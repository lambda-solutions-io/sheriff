/**
 * Segment-aware containment check.
 *
 * A plain `startsWith(rootDir)` is not segment-aware: with a root of
 * `/repo/src` it wrongly accepts `/repo/src2/x.ts`, because the prefix
 * matches mid-segment. A path counts as inside the root only when it is the
 * root itself or continues after a separator.
 *
 * Paths reaching this check can mix `/` and `\` (tsconfig-derived vs
 * fs-derived on Windows), so both are accepted as boundaries — the same
 * assumption the module walk in `create-modules.ts` makes.
 */
export function isInsideRoot(path: string, rootDir: string): boolean {
  const normalizedRoot = stripTrailingSeparator(rootDir);

  if (!path.startsWith(normalizedRoot)) {
    return false;
  }

  if (path.length === normalizedRoot.length) {
    return true;
  }

  return isSeparator(path[normalizedRoot.length]);
}

function stripTrailingSeparator(path: string): string {
  let end = path.length;
  while (end > 1 && isSeparator(path[end - 1])) {
    end--;
  }
  return path.substring(0, end);
}

function isSeparator(character: string): boolean {
  return character === '/' || character === '\\';
}
