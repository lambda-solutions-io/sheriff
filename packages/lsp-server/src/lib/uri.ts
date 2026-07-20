export function filePathToUri(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const pathname = normalizedPath.startsWith('/')
    ? normalizedPath
    : `/${normalizedPath}`;
  // encode per segment; encodeURI would leave '?' and '%' intact and
  // break the uriToFilePath roundtrip. Keep Windows drive colons.
  const encoded = pathname
    .split('/')
    .map((segment) =>
      /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join('/');
  return `file://${encoded}`;
}

export function uriToFilePath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:') {
    throw new Error(`Unsupported URI protocol: ${url.protocol}`);
  }

  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    return pathname.slice(1).replaceAll('/', '\\');
  }

  return url.hostname ? `//${url.hostname}${pathname}` : pathname;
}
