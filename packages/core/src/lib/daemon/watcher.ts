import * as fs from 'fs';
import * as path from 'path';
import { toFsPath } from '../file-info/fs-path';
import {
  invalidatePath,
  invalidateStructure,
} from '../cache/project-cache';

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.angular',
  '.nx',
  'coverage',
]);

export type WatcherOptions = {
  /** Absolute directory to watch recursively. */
  rootDir: string;
  /** Fires after cache invalidation for every relevant change. */
  onInvalidate?: (changedFile: string) => void;
  /**
   * Fires when a sheriff config changes. The daemon restarts on this
   * because the config is evaluated code — re-evaluating in a
   * long-lived process would keep its previous ambient state alive.
   */
  onConfigChange?: (configFile: string) => void;
};

/**
 * Watches the project for changes and translates filesystem events into
 * targeted project-cache invalidations: a content change drops entries
 * depending on that file, add/unlink additionally drops the
 * structure-dependent entries (module paths, manifest locations).
 *
 * Uses node's recursive `fs.watch` (supported on macOS, Windows, and
 * Linux with Node >= 20) to avoid a native watcher dependency.
 */
export function startWatcher(options: WatcherOptions): { close: () => void } {
  const { rootDir, onInvalidate, onConfigChange } = options;

  const watcher = fs.watch(
    rootDir,
    { recursive: true },
    (_eventType, filename) => {
      if (!filename || isIgnored(filename)) {
        return;
      }

      const absolutePath = path.join(rootDir, filename.toString());

      if (path.basename(absolutePath) === 'sheriff.config.ts') {
        onConfigChange?.(absolutePath);
        return;
      }

      // `fs.watch` does not distinguish add/unlink from content changes
      // reliably across platforms, so a structural drop happens for
      // every event. Structure caches are cheap to rebuild once.
      invalidateStructure();
      try {
        invalidatePath(toFsPath(absolutePath));
      } catch {
        // deleted files cannot be converted to an FsPath; their cache
        // entries die through dependency validation instead
      }

      onInvalidate?.(absolutePath);
    },
  );

  return { close: () => watcher.close() };
}

function isIgnored(filename: string | Buffer): boolean {
  return filename
    .toString()
    .split(/[\\/]/)
    .some((segment) => IGNORED_DIRECTORIES.has(segment));
}
