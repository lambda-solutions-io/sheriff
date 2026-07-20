export function filePathToUri(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const pathname = normalizedPath.startsWith('/')
    ? normalizedPath
    : `/${normalizedPath}`;
  return `file://${encodeURI(pathname).replaceAll('#', '%23')}`;
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

  return pathname;
}
