// endProcess* return void (not never) so watch mode can no-op them
export const cli: {
  endProcessOk: () => void;
  endProcessError: () => void;
  log: (message: string) => void;
  logError: (message: string) => void;
  bold: (text: string) => string;
} = {
  endProcessOk: () => process.exit(0),
  endProcessError: () => process.exit(1),
  log: (message: string) => console.log(message),
  logError: (message: string) => console.error(message),
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
};
