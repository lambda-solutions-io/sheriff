import * as fs from 'fs';
import * as path from 'path';
import {
  FsPath,
  toFsPath,
  toFsPathFromDirent,
} from '../file-info/fs-path';
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
  const knownPaths = scanKnownPaths(rootDir);

  const watcher = fs.watch(
    rootDir,
    { recursive: true },
    (eventType, filename) => {
      if (!filename || isIgnored(filename)) {
        return;
      }

      const absolutePath = path.join(rootDir, filename.toString());

      if (path.basename(absolutePath) === 'sheriff.config.ts') {
        onConfigChange?.(absolutePath);
        return;
      }

      const knownPath = knownPaths.get(absolutePath);
      const existsNow = safeExists(absolutePath);
      const isContentChange =
        isSupportedEventType(eventType) &&
        knownPath !== undefined &&
        existsNow === true;

      let pathToInvalidate = knownPath;
      if (existsNow === true && pathToInvalidate === undefined) {
        try {
          pathToInvalidate = toFsPath(absolutePath);
          knownPaths.set(absolutePath, pathToInvalidate);
        } catch {
          // The path vanished between the direct existence probe and
          // conversion. The structural invalidation below is conservative.
        }
      } else if (existsNow === false) {
        removeKnownPathAndDescendants(knownPaths, absolutePath);
      }

      if (!isContentChange) {
        // New, removed, unknown, or ambiguous paths can change module
        // resolution for imports anywhere in the project.
        invalidateStructure();
      }
      if (pathToInvalidate !== undefined) {
        invalidatePath(pathToInvalidate);
      }

      onInvalidate?.(absolutePath);
    },
  );

  return { close: () => watcher.close() };
}

function scanKnownPaths(rootDir: string): Map<string, FsPath> {
  const knownPaths = new Map<string, FsPath>();
  scanDirectory(rootDir, knownPaths);
  return knownPaths;
}

function scanDirectory(directory: string, knownPaths: Map<string, FsPath>) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    // An incomplete initial scan only causes extra structural invalidations:
    // an unrecorded path is always treated conservatively as newly present.
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (isIgnored(entry.name)) {
      continue;
    }

    knownPaths.set(absolutePath, toFsPathFromDirent(absolutePath));
    if (entry.isDirectory()) {
      scanDirectory(absolutePath, knownPaths);
    }
  }
}

function safeExists(absolutePath: string): boolean | undefined {
  try {
    return fs.existsSync(absolutePath);
  } catch {
    // Unknown is distinct from missing so callers retain conservative state.
    return undefined;
  }
}

function isSupportedEventType(eventType: string): boolean {
  return eventType === 'change' || eventType === 'rename';
}

function removeKnownPathAndDescendants(
  knownPaths: Map<string, FsPath>,
  absolutePath: string,
) {
  const descendantPrefix = `${absolutePath}${path.sep}`;
  for (const knownPath of knownPaths.keys()) {
    if (knownPath === absolutePath || knownPath.startsWith(descendantPrefix)) {
      knownPaths.delete(knownPath);
    }
  }
}

function isIgnored(filename: string | Buffer): boolean {
  return filename
    .toString()
    .split(/[\\/]/)
    .some((segment) => IGNORED_DIRECTORIES.has(segment));
}
