import type {
  SheriffPlugin,
  SheriffPluginAPI,
} from '@lambda-solutions/sheriff-core';
import { GraphDataProvider } from '../data/data-provider';
import { DaemonDataProvider } from '../data/daemon-data-provider';
import { buildGraph } from '../graph/build-graph';
import { openBrowser } from '../server/open-browser';
import { startUiServer } from '../server/ui-server';
import { parseUiArgs } from './parse-args';

export type SheriffUiPluginOptions = {
  port?: number;
  open?: boolean;
  /** Replaces the daemon-backed provider; used by tests. */
  providerFactory?: (rootDir: string) => GraphDataProvider;
};

/**
 * `sheriff ui [--port <n>] [--no-open] [--json] [--entry-file <file>]`
 *
 * Serves a live-updating module graph. Data comes from the sheriff
 * daemon, whose filesystem watcher keeps every poll current. `--json`
 * prints one graph snapshot and exits (used by integration tests).
 */
export class SheriffUiPlugin implements SheriffPlugin {
  readonly name = 'ui';
  readonly description = 'Open Sheriff UI';
  readonly #options: SheriffUiPluginOptions;

  constructor(options: SheriffUiPluginOptions = {}) {
    this.#options = options;
  }

  async execute(args: string[], api: SheriffPluginAPI): Promise<void> {
    const parsed = parseUiArgs(args, this.#options);
    const rootDir = process.cwd();
    const provider =
      this.#options.providerFactory?.(rootDir) ??
      new DaemonDataProvider({
        rootDir,
        // the plugin runs inside the sheriff CLI process, so argv[1]
        // is the sheriff bin the daemon must be spawned from
        cliBinPath: resolveCliBinPath(),
      });

    try {
      if (parsed.json) {
        const snapshot = await provider.fetchSnapshot(parsed.entryFile);
        const graph = buildGraph(
          snapshot.entries,
          snapshot.verification,
          snapshot.rootDir,
        );
        api.log(JSON.stringify(graph, null, 2));
        return;
      }

      const server = await startUiServer({
        provider,
        port: parsed.port,
        entryFile: parsed.entryFile,
      });
      const url = `http://localhost:${server.port}`;
      api.log(`Sheriff UI running at ${url} (Ctrl-C to stop)`);
      if (parsed.open) {
        openBrowser(url);
      }

      await waitForShutdownSignal();
      await server.close();
    } finally {
      await provider.close();
    }
  }
}

function resolveCliBinPath(): string {
  const argvBin = process.argv[1];
  if (argvBin && /sheriff|main\.js$/.test(argvBin)) {
    return argvBin;
  }
  try {
    return require.resolve('@lambda-solutions/sheriff-core/src/bin/main.js');
  } catch {
    return argvBin ?? '';
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}
