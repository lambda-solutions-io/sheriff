import { cli } from './cli';
import { verify } from './verify';
import { handleErrorOutput } from './internal/handle-error';
import { startWatcher } from '../daemon/watcher';
import { clearProjectCache } from '../cache/project-cache';

const RERUN_DEBOUNCE_MS = 100;

/**
 * `sheriff verify --watch`: keeps the process alive, re-verifies on
 * every relevant filesystem change, and reuses the project cache so
 * only changed files are re-analyzed.
 */
export function verifyWatch(
  args: string[],
  options: { files?: string[] } = {},
): void {
  const rootDir = process.cwd();

  // verify() ends the process after a single run; watch runs must survive
  cli.endProcessOk = () => void 0;
  cli.endProcessError = () => void 0;

  let rerunTimer: ReturnType<typeof setTimeout> | undefined;

  const runVerification = () => {
    try {
      // `--files` keeps the same meaning as one-shot verify: every
      // relevant change triggers a rerun, but the verified set stays the
      // static file list supplied by the caller. Non-listed changes still
      // rerun because imports or module structure may affect listed files.
      verify(args, options);
    } catch (error) {
      handleErrorOutput(error);
    }
    cli.log('');
    cli.log(getWatchingMessage(options.files));
  };

  const scheduleRun = () => {
    // editors emit bursts of events per save
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(runVerification, RERUN_DEBOUNCE_MS);
  };

  // `let` (not `const`) + assign-after-declare so onError can close the
  // watcher even if fs.watch ever emitted 'error' synchronously during
  // the startWatcher call below (TDZ on `const watcher = startWatcher(...)`
  // referenced from inside its own options otherwise)
  let watcher: { close: () => void };
  // eslint-disable-next-line prefer-const
  watcher = startWatcher({
    rootDir,
    onInvalidate: scheduleRun,
    onConfigChange: () => {
      clearProjectCache();
      scheduleRun();
    },
    // an unwatchable root (ENOSPC, EPERM, renamed/deleted root) means
    // further changes can no longer be tracked; report and exit rather
    // than crash uncaught or keep running with a stale cache
    onError: (error) => {
      clearTimeout(rerunTimer);
      watcher.close();
      handleErrorOutput(error);
      process.exitCode = 1;
    },
  });

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  runVerification();
}

function getWatchingMessage(files: string[] | undefined): string {
  if (files && files.length > 0) {
    return `watching for changes... verifying only ${files.join(
      ', ',
    )} (ctrl+c to quit)`;
  }

  return 'watching for changes... (ctrl+c to quit)';
}
