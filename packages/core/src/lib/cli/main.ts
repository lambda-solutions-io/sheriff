#!/usr/bin/env node

import { handleError, handleErrorAsync } from './internal/handle-error';
import { init } from './init';
import { verify } from './verify';
import { list } from './list';
import { cli } from './cli';
import { exportData } from './export-data';
import { version } from './version';
import {version as packageVersion} from '../../../package.json';
import { getPlugins } from './internal/get-plugins';
import { executePlugin } from './plugin-command';
import { SheriffPlugin } from '../plugin/plugin';

const BUILTIN_COMMANDS = new Set(['init', 'verify', 'list', 'export', 'version']);

function isBuiltinCommand(cmd: string | undefined): boolean {
  return cmd !== undefined && BUILTIN_COMMANDS.has(cmd);
}

function showHelp(plugins: SheriffPlugin[]): void {
  cli.log(
    cli.bold(`Sheriff (${packageVersion}) - Modularity for TypeScript Projects`),
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
    'For more information, visit: https://github.com/softarc-consulting/sheriff',
  );
}

async function handlePluginOrHelp(
  cmd: string | undefined,
  args: string[],
): Promise<void> {
  const { config, plugins } = getPlugins();

  if (cmd === undefined) {
    showHelp(plugins);
    return;
  }

  const plugin = plugins.find((candidate) => candidate.name === cmd);

  if (!plugin || !config) {
    showHelp(plugins);
    return;
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
      case 'verify':
        handleError(() => verify(args));
        break;
      case 'list':
        handleError(() => list(args));
        break;
      case 'export':
        handleError(() => exportData(...args));
        break;
      case 'version':
        version();
        break;
    }
    return;
  }

  handleErrorAsync(() => handlePluginOrHelp(cmd, args));
}
