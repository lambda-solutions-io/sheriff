#!/usr/bin/env node

import { handleError, handleErrorAsync } from './internal/handle-error';
import { init } from './init';
import { verify } from './verify';
import { verifyWatch } from './verify-watch';
import { daemonCommand } from './daemon-command';
import { list } from './list';
import { doctor } from './doctor';
import { cli } from './cli';
import { exportData } from './export-data';
import { version } from './version';
import { version as packageVersion } from '../../../package.json';
import { getPlugins } from './internal/get-plugins';
import { executePlugin } from './plugin-command';
import { SheriffPlugin } from '../plugin/plugin';
import { BUILTIN_COMMANDS } from './internal/builtin-commands';
import { PluginNotFoundError } from '../error/user-error';

function isBuiltinCommand(cmd: string | undefined): boolean {
  return cmd !== undefined && BUILTIN_COMMANDS.has(cmd);
}

function showHelp(plugins: SheriffPlugin[]): void {
  cli.log(
    cli.bold(
      `Sheriff (${packageVersion}) - Modularity for TypeScript Projects`,
    ),
  );
  cli.log('');
  cli.log('Commands:');
  cli.log(
    "  sheriff export [main.ts]: Exports the project's, along its dependencies and modules in json.",
  );
  cli.log(
    '  sheriff init [main.ts]: initializes Sheriff by adding a sheriff.config.ts.',
  );
  cli.log(
    '  sheriff list [main.ts]: lists the current modules of the project.',
  );
  cli.log(
    '  sheriff verify [main.ts]: runs the verification process for the project.',
  );
  cli.log(
    '  sheriff verify --watch [main.ts]: re-runs the verification on file changes.',
  );
  cli.log(
    '  sheriff doctor [main.ts]: runs diagnostic checks and prints a grouped report (--json for machine-readable output).',
  );
  cli.log(
    '  sheriff daemon <start|stop|status>: manages the background daemon.',
  );
  cli.log('  sheriff version: prints out the current version.');

  if (plugins.length > 0) {
    cli.log('');
    cli.log('Plugins:');
    plugins.forEach((plugin) => {
      const description = plugin.description ? `: ${plugin.description}` : '';
      cli.log(`  sheriff ${plugin.name}${description}`);
    });
  }

  cli.log('');
  cli.log(
    '[main.ts] is optional if a sheriff.config.ts with an entryFile property is in the current path.',
  );
  cli.log(
    'For more information, visit: https://github.com/michaelbe812/sheriff',
  );
}

async function handlePluginOrHelp(
  cmd: string | undefined,
  args: string[],
): Promise<void> {
  if (cmd === undefined) {
    // help must stay reachable even with a broken sheriff.config.ts
    let plugins: SheriffPlugin[] = [];
    try {
      plugins = getPlugins().plugins;
    } catch {
      // ignore config errors, show plugin-less help
    }
    showHelp(plugins);
    return;
  }

  const { config, plugins } = getPlugins();
  const plugin = plugins.find((candidate) => candidate.name === cmd);

  if (!plugin || !config) {
    throw new PluginNotFoundError(cmd);
  }

  await executePlugin(cmd, args, plugins, config);
}

export function main(...argv: string[]) {
  const [cmd, ...args] = argv;

  if (isBuiltinCommand(cmd)) {
    switch (cmd) {
      case 'init':
        handleError(() => init());
        break;
      case 'verify': {
        const { args: verifyArgs, files } = parseVerifyFilesOption(args);
        if (verifyArgs.includes('--watch')) {
          // watch mode keeps the process alive; no endProcess handling
          verifyWatch(
            verifyArgs.filter((arg) => arg !== '--watch'),
            {
              files,
            },
          );
          break;
        }
        handleError(() => verify(verifyArgs, { files }));
        break;
      }
      case 'list':
        handleError(() => list(args));
        break;
      case 'doctor': {
        const { args: doctorArgs, json } = parseJsonOption(args);
        handleError(() => doctor(doctorArgs, { json }));
        break;
      }
      case 'export':
        handleError(() => exportData(...args));
        break;
      case 'version':
        version();
        break;
      case 'daemon':
        if (args[0] === 'run') {
          // foreground server must not exit after startup
          return daemonCommand(args).catch((error) => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
          });
        }
        return handleErrorAsync(() => daemonCommand(args));
    }
    return;
  }

  return handleErrorAsync(() => handlePluginOrHelp(cmd, args));
}

/**
 * Parses the `--json` flag for `doctor`.
 *
 * With `--json`, the doctor report is emitted as a machine-readable JSON
 * structure instead of the human-readable one. The flag is positionally
 * independent and removed from the remaining arguments.
 */
function parseJsonOption(args: string[]): {
  args: string[];
  json: boolean;
} {
  return {
    args: args.filter((arg) => arg !== '--json'),
    json: args.includes('--json'),
  };
}

function splitFileValues(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(/[,\s]+/))
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}

/**
 * Parses the `--files` option for `verify`.
 *
 * Convention: the optional entry file must come BEFORE `--files`
 * (`sheriff verify main.ts --files a.ts b.ts`). Every token after `--files`
 * is treated as a file; the entry is never swallowed into the file list.
 *
 * Both forms are accepted:
 *   `--files a.ts b.ts`   (space-separated)
 *   `--files a.ts,b.ts`   (comma-separated)
 *   `--files=a.ts,b.ts`   (equals form)
 *
 * A bare `--files` (or one resolving to zero files) yields an empty list,
 * which the verify command short-circuits to a successful no-op.
 */
function parseVerifyFilesOption(args: string[]): {
  args: string[];
  files: string[] | undefined;
} {
  const equalsFlagIndex = args.findIndex((arg) => arg.startsWith('--files='));
  if (equalsFlagIndex !== -1) {
    const files = splitFileValues([
      args[equalsFlagIndex].slice('--files='.length),
    ]);
    return {
      args: [
        ...args.slice(0, equalsFlagIndex),
        ...args.slice(equalsFlagIndex + 1),
      ],
      files,
    };
  }

  const filesFlagIndex = args.indexOf('--files');
  if (filesFlagIndex === -1) {
    return { args, files: undefined };
  }

  // Everything after `--files` up to the next `--` flag is a file value.
  let valuesEndIndex = filesFlagIndex + 1;
  while (
    valuesEndIndex < args.length &&
    !args[valuesEndIndex].startsWith('--')
  ) {
    valuesEndIndex++;
  }

  const files = splitFileValues(args.slice(filesFlagIndex + 1, valuesEndIndex));

  return {
    args: [...args.slice(0, filesFlagIndex), ...args.slice(valuesEndIndex)],
    files,
  };
}
