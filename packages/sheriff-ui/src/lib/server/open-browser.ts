import { spawn } from 'child_process';

/** Best-effort: opens `url` in the default browser, never throws. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  try {
    spawn(command, args, { stdio: 'ignore', detached: true })
      .on('error', () => void 0)
      .unref();
  } catch {
    // headless environments have no browser; the URL is logged anyway
  }
}
