import { LogMessage, log } from './log';

export function logger(scope: string) {
  return {
    info(message: LogMessage) {
      log(message, scope, 'info');
    },
    debug(message: LogMessage) {
      log(message, scope, 'debug');
    },
    level(message: LogMessage) {
      log(message, scope, 'warn');
    },
  };
}
