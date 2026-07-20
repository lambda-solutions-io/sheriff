import { pid } from 'process';
import { LogLevel } from './log-level';
import { afterInit } from '../main/after-init';
import getFs from '../fs/getFs';

export type LogMessage = string | (() => string);

let logQueue: (() => string)[] = [];
let initialized = false;
let enabled = false;

/**
 * resets the logger. only used in tests.
 */
export const reset = () => {
  initialized = false;
  enabled = false;
  logQueue = [];
};

afterInit((config) => {
  enabled = Boolean(config?.log);
  if (enabled) {
    for (const getData of logQueue) {
      doLog(getData());
    }
  }
  logQueue = [];
  initialized = true;
});

export function log(message: LogMessage, scope = '', level: LogLevel) {
  if (initialized && !enabled) {
    return;
  }

  const timestamp = new Date().toISOString();
  const getData = () =>
    [
      scope,
      timestamp,
      level,
      pid,
      typeof message === 'function' ? message() : message,
    ].join(' - ');

  if (initialized) {
    doLog(getData());
  } else {
    logQueue.push(getData);
  }
}

export function doLog(data: string) {
  getFs().appendFile('sheriff.log', data);
}
