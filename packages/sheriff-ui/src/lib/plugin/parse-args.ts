export type UiArgs = {
  port: number;
  open: boolean;
  json: boolean;
  entryFile?: string;
};

export const DEFAULT_PORT = 7654;

export function parseUiArgs(
  args: string[],
  defaults: Partial<Pick<UiArgs, 'port' | 'open'>> = {},
): UiArgs {
  const parsed: UiArgs = {
    port: defaults.port ?? DEFAULT_PORT,
    open: defaults.open ?? true,
    json: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case '--port': {
        const value = Number(args[++index]);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new Error(`invalid --port value: ${args[index] ?? ''}`);
        }
        parsed.port = value;
        break;
      }
      case '--no-open':
        parsed.open = false;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--entry-file': {
        const value = args[++index];
        if (!value) {
          throw new Error('--entry-file requires a value');
        }
        parsed.entryFile = value;
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return parsed;
}
