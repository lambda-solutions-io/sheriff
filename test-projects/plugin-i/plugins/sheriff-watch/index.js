// Long-running / interactive plugin example.
//
// Starts a readline REPL that stays alive and re-queries Sheriff's API on
// demand. Both `verify()` and `getProjectData()` read through Sheriff's
// process-level project cache, so the heavy filesystem work (parsing configs,
// resolving imports, traversing the module graph) happens once on the first
// call and is reused on every subsequent call until a source file changes.
//
// Rather than asserting the cache benefit, this example MEASURES and prints
// the elapsed time per API call, so the warm-cache speed-up is observable:
// the first `verify`/`data` pays the cold cost, later calls are visibly
// faster.
//
// Interactive mode is entered when stdin is a TTY. When stdin is piped (not a
// TTY) the plugin reads all piped command lines, runs them, then exits — so
// `printf 'both\nquit\n' | npx sheriff watch` is deterministic and never
// hangs a non-interactive caller.

const readline = require('node:readline');

const HELP =
  'commands: verify | data | both | quit (also exit). Ctrl-D / Ctrl-C to stop.';

class SheriffWatchPlugin {
  constructor() {
    this.name = 'watch';
    this.description =
      'Interactive REPL that re-queries Sheriff, reusing the project cache';
  }

  async execute(_args, api) {
    api.log('watch: interactive session started; repeated calls reuse the project cache');
    api.log(HELP);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
      prompt: 'watch> ',
    });

    await new Promise((resolve) => {
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        rl.close();
        api.log('watch: session ended');
        resolve();
      };

      rl.on('line', (line) => {
        const command = line.trim().toLowerCase();
        if (command === '') {
          rl.prompt();
          return;
        }
        if (command === 'quit' || command === 'exit') {
          finish();
          return;
        }
        this.#runCommand(command, api);
        rl.prompt();
      });

      // stdin EOF (piped input drained, or Ctrl-D) and SIGINT both exit cleanly.
      rl.on('close', finish);
      rl.on('SIGINT', finish);

      rl.prompt();
    });
  }

  #runCommand(command, api) {
    switch (command) {
      case 'verify':
        this.#doVerify(api);
        break;
      case 'data':
        this.#doData(api);
        break;
      case 'both':
        this.#doVerify(api);
        this.#doData(api);
        break;
      default:
        api.log(`watch: unknown command "${command}". ${HELP}`);
    }
  }

  #doVerify(api) {
    const { result, ms } = this.#timed(() => api.verify());
    api.log(
      `watch verify: success=${result.success} ` +
        `violations=${result.filesWithViolationsCount} (${ms}ms)`,
    );
  }

  #doData(api) {
    const { result: projectData, ms } = this.#timed(() =>
      api.getProjectData(),
    );
    // ProjectData is keyed by file path (one node per file), so this is a
    // file/node count — not a module count.
    const fileCount = Object.keys(projectData).length;
    api.log(`watch data: files=${fileCount} (${ms}ms)`);
  }

  // Measures elapsed wall-clock time (ms) around a single API call so the
  // warm-cache benefit is observable in the output.
  #timed(fn) {
    const start = process.hrtime.bigint();
    const result = fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { result, ms: ms.toFixed(1) };
  }
}

exports.SheriffWatchPlugin = SheriffWatchPlugin;
