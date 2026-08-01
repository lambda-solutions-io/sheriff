import { cli } from './cli';
import { startDaemonServer } from '../daemon/server';
import { DaemonClient, getDaemonStatus, stopDaemon } from '../daemon/client';

/**
 * `sheriff daemon <start|stop|status|run>`. `run` hosts the server in
 * the foreground and is what `start` spawns detached.
 */
export async function daemonCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  const rootDir = process.cwd();

  switch (subcommand) {
    case 'run': {
      await startDaemonServer({ rootDir, log: (message) => cli.log(message) });
      return;
    }
    case 'start': {
      const runningDaemon = await getDaemonStatus(rootDir);
      if (runningDaemon) {
        cli.log(`sheriff daemon already running (pid ${runningDaemon.pid})`);
        return;
      }
      const client = await DaemonClient.connect(rootDir, {
        spawnIfMissing: true,
        cliBinPath: process.argv[1],
      });
      if (!client) {
        throw new Error('could not start the sheriff daemon');
      }
      client.close();
      cli.log('sheriff daemon started');
      return;
    }
    case 'stop': {
      cli.log(
        (await stopDaemon(rootDir))
          ? 'sheriff daemon stopped'
          : 'no sheriff daemon running',
      );
      return;
    }
    case 'status': {
      const status = await getDaemonStatus(rootDir);
      cli.log(
        status
          ? `sheriff daemon running (pid ${status.pid}, version ${status.coreVersion}, compatible ${status.compatible ? 'yes' : 'no'})`
          : 'no sheriff daemon running',
      );
      return;
    }
    default:
      throw new Error(
        `unknown daemon subcommand '${subcommand ?? ''}' (use start|stop|status|run)`,
      );
  }
}
