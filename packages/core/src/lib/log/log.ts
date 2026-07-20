import { pid } from 'process';
import { LogLevel } from './log-level';
import { afterInit } from '../main/after-init';
import getFs from '../fs/getFs';

export type LogMessage = string | (() => string);

/**
 * Pre-init messages are queued as thunks; the cap prevents unbounded
 * retention of closures (and their captured graphs) when init never runs.
 */
const MAX_PRE_INIT_QUEUE = 1000;
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
    if (logQueue.length >= MAX_PRE_INIT_QUEUE) {
      logQueue.shift();
    }
    logQueue.push(getData);
  }
}

export function doLog(data: string) {
  getFs().appendFile('sheriff.log', data);
}
