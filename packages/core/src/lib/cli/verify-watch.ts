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
  options: { verbose?: boolean } = {},
): void {
  const rootDir = process.cwd();

  // verify() ends the process after a single run; watch runs must survive
  cli.endProcessOk = () => void 0;
  cli.endProcessError = () => void 0;

  let rerunTimer: ReturnType<typeof setTimeout> | undefined;

  const runVerification = () => {
    try {
      verify(args, options);
    } catch (error) {
      handleErrorOutput(error);
    }
    cli.log('');
    cli.log('watching for changes... (ctrl+c to quit)');
  };

  const scheduleRun = () => {
    // editors emit bursts of events per save
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(runVerification, RERUN_DEBOUNCE_MS);
  };

  const watcher = startWatcher({
    rootDir,
    onInvalidate: scheduleRun,
    onConfigChange: () => {
      clearProjectCache();
      scheduleRun();
    },
  });

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  runVerification();
}
