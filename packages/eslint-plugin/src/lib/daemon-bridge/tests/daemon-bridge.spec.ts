import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDaemonBridgeEnabled,
  lintFileViaDaemon,
  resetDaemonBridgeForTests,
} from '../daemon-bridge';
import type { DaemonLintResult } from '../daemon-bridge';
import {
  daemonDeepImportMessage,
  daemonDependencyMessage,
  daemonEncapsulationMessage,
  resetDaemonLintCacheForTests,
} from '../daemon-lint-cache';

const synckitMocks = vi.hoisted(() => ({
  createSyncFn: vi.fn(),
  runAsWorker: vi.fn(),
}));

vi.mock('synckit', () => synckitMocks);

const emptyLintResult: DaemonLintResult = {
  dependencyRuleViolations: [],
  encapsulationViolations: [],
  externalRuleViolations: [],
  unresolvableImports: [],
};

const originalSheriffDaemon = process.env['SHERIFF_DAEMON'];

describe('daemon bridge', () => {
  beforeEach(() => {
    delete process.env['SHERIFF_DAEMON'];
    synckitMocks.createSyncFn.mockReset();
    synckitMocks.runAsWorker.mockReset();
    resetDaemonBridgeForTests();
    resetDaemonLintCacheForTests();
  });

  afterEach(() => {
    if (originalSheriffDaemon === undefined) {
      delete process.env['SHERIFF_DAEMON'];
    } else {
      process.env['SHERIFF_DAEMON'] = originalSheriffDaemon;
    }
    resetDaemonBridgeForTests();
    resetDaemonLintCacheForTests();
  });

  it('reads the opt-in environment variable at call time', () => {
    expect(isDaemonBridgeEnabled()).toBe(false);

    process.env['SHERIFF_DAEMON'] = '1';
    resetDaemonBridgeForTests();

    expect(isDaemonBridgeEnabled()).toBe(true);
  });

  it('returns the lint result from the synchronous worker', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    const syncLintFile = vi.fn(() => emptyLintResult);
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);

    expect(lintFileViaDaemon('/project/file.ts', 'const value = 1;')).toBe(
      emptyLintResult,
    );
    expect(syncLintFile).toHaveBeenCalledWith(
      process.cwd(),
      '/project/file.ts',
      'const value = 1;',
    );
  });

  it('falls back for a single slow call without disabling the bridge', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    let calls = 0;
    const syncLintFile = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('daemon call timed out');
      }
      return emptyLintResult;
    });
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);

    // First call is slow: fall back in-process for THAT call only.
    expect(lintFileViaDaemon('/project/file.ts', '')).toBeUndefined();
    // The bridge stays on so later files can still use the daemon.
    expect(isDaemonBridgeEnabled()).toBe(true);
    expect(lintFileViaDaemon('/project/other.ts', '')).toBe(emptyLintResult);
    expect(isDaemonBridgeEnabled()).toBe(true);
  });

  it('permanently disables the bridge after repeated consecutive failures', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    const syncLintFile = vi.fn(() => {
      throw new Error('daemon call timed out');
    });
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);

    expect(lintFileViaDaemon('/project/a.ts', '')).toBeUndefined();
    expect(isDaemonBridgeEnabled()).toBe(true);
    expect(lintFileViaDaemon('/project/b.ts', '')).toBeUndefined();
    expect(isDaemonBridgeEnabled()).toBe(true);
    // Third consecutive failure trips the permanent, CI-safe fallback.
    expect(lintFileViaDaemon('/project/c.ts', '')).toBeUndefined();
    expect(isDaemonBridgeEnabled()).toBe(false);
    // No further worker calls once disabled.
    expect(lintFileViaDaemon('/project/d.ts', '')).toBeUndefined();
    expect(syncLintFile).toHaveBeenCalledTimes(3);
  });

  it('reads a larger per-call timeout, configurable via SHERIFF_DAEMON_TIMEOUT_MS', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => emptyLintResult));

    lintFileViaDaemon('/project/file.ts', '');
    expect(synckitMocks.createSyncFn).toHaveBeenCalledWith(
      expect.any(String),
      { timeout: 5000 },
    );

    resetDaemonBridgeForTests();
    synckitMocks.createSyncFn.mockReset();
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => emptyLintResult));
    process.env['SHERIFF_DAEMON_TIMEOUT_MS'] = '12000';
    lintFileViaDaemon('/project/file.ts', '');
    expect(synckitMocks.createSyncFn).toHaveBeenCalledWith(
      expect.any(String),
      { timeout: 12000 },
    );
    delete process.env['SHERIFF_DAEMON_TIMEOUT_MS'];
  });

  it('maps daemon violations by rule and reuses the per-file cache', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    const lintResult: DaemonLintResult = {
      dependencyRuleViolations: [
        {
          fromTag: 'feature',
          toTags: ['data', 'shared'],
          rawImport: '@app/data',
        },
      ],
      encapsulationViolations: ['@app/internal'],
      externalRuleViolations: [
        {
          fromTag: 'feature',
          externalLibrary: 'restricted-library',
        },
      ],
      unresolvableImports: [],
    };
    const syncLintFile = vi.fn(() => lintResult);
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);
    const lintRun = {};

    expect(
      daemonEncapsulationMessage(
        '/project/file.ts',
        '@app/internal',
        true,
        'source code',
        lintRun,
      ),
    ).toBe("'@app/internal' cannot be imported. It is encapsulated.");
    expect(
      daemonDependencyMessage(
        '/project/file.ts',
        '@app/data',
        true,
        'source code',
        lintRun,
      ),
    ).toBe(
      "module import '@app/data' violates the dependency rule. Tag feature has no clearance for tags data, shared",
    );
    expect(
      daemonDependencyMessage(
        '/project/file.ts',
        'restricted-library',
        false,
        'source code',
        lintRun,
      ),
    ).toBe(
      'module cannot import external library restricted-library. Tag feature has no clearance in externalRules',
    );
    expect(
      daemonEncapsulationMessage(
        '/project/file.ts',
        '@app/clean',
        false,
        'source code',
        lintRun,
      ),
    ).toBe('');
    expect(
      daemonDeepImportMessage(
        '/project/file.ts',
        '@app/internal',
        true,
        'source code',
        lintRun,
      ),
    ).toBe("Deep import is not allowed. Use the module's index.ts or path.");
    expect(
      daemonDependencyMessage(
        '/project/file.ts',
        '@app/clean',
        false,
        'source code',
        lintRun,
      ),
    ).toBe('');
    expect(syncLintFile).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the same rule starts another lint pass', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    const syncLintFile = vi.fn(() => emptyLintResult);
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);

    daemonDependencyMessage('/project/file.ts', '@app/a', true, 'source');
    daemonEncapsulationMessage('/project/file.ts', '@app/a', true, 'source');
    expect(syncLintFile).toHaveBeenCalledTimes(1);

    daemonDependencyMessage('/project/file.ts', '@app/a', true, 'source');
    expect(syncLintFile).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a result across different ESLint lint runs', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    const syncLintFile = vi.fn(() => emptyLintResult);
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);

    daemonDependencyMessage(
      '/project/file.ts',
      '@app/a',
      true,
      'source',
      {},
    );
    daemonEncapsulationMessage(
      '/project/file.ts',
      '@app/a',
      true,
      'source',
      {},
    );

    expect(syncLintFile).toHaveBeenCalledTimes(2);
  });

  it('falls back instead of reusing an entry evicted by later files', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => emptyLintResult));
    const lintRun = {};

    // Prime the file, then lint enough other files to evict it (cap is 512).
    daemonDependencyMessage('/project/file.ts', '@app/a', true, 'src', lintRun);
    for (let index = 0; index < 512; index++) {
      daemonDependencyMessage(`/project/f${index}.ts`, '@app/a', true, 'src', {});
    }

    // A later node of the evicted file must not report "no violation" from a
    // cache entry that no longer exists; it falls back in-process.
    expect(
      daemonDependencyMessage('/project/file.ts', '@app/a', false, 'src', lintRun),
    ).toBeUndefined();

    // Re-priming the same file on a fresh first run must go back to the daemon
    // rather than answer from a surviving entry of a different lint run.
    const syncLintFile = vi.fn(() => emptyLintResult);
    synckitMocks.createSyncFn.mockReturnValue(syncLintFile);
    resetDaemonBridgeForTests();
    expect(
      daemonDependencyMessage('/project/file.ts', '@app/a', true, 'src', lintRun),
    ).toBe('');
    expect(syncLintFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a file being linted alive by touching the cache on later nodes', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => emptyLintResult));
    const lintRun = {};

    daemonDependencyMessage('/project/file.ts', '@app/a', true, 'src', lintRun);
    // 511 other files leave the cache exactly full, with our file the oldest.
    for (let index = 0; index < 511; index++) {
      daemonDependencyMessage(`/project/f${index}.ts`, '@app/a', true, 'src', {});
    }
    // A later node of the file refreshes its recency ...
    expect(
      daemonDependencyMessage('/project/file.ts', '@app/a', false, 'src', lintRun),
    ).toBe('');
    // ... so the next file evicts a different entry, not the one in use.
    daemonDependencyMessage('/project/last.ts', '@app/a', true, 'src', {});

    expect(
      daemonDependencyMessage('/project/file.ts', '@app/a', false, 'src', lintRun),
    ).toBe('');
  });

  it('falls back instead of reusing a stale entry from a previous lint run', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => emptyLintResult));

    daemonDependencyMessage('/project/file.ts', '@app/a', true, 'old src', {});

    // Same file, new lint run and edited source: the previous run's entry must
    // not answer for it.
    expect(
      daemonDependencyMessage('/project/file.ts', '@app/a', false, 'new src', {}),
    ).toBeUndefined();
  });

  it('reports unresolvable relative imports with the in-process wording', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    const lintResult: DaemonLintResult = {
      dependencyRuleViolations: [],
      encapsulationViolations: [],
      externalRuleViolations: [],
      unresolvableImports: ['./missing'],
    };
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => lintResult));

    // Both rules must emit the exact message the in-process adapters produce
    // (`import <importCommand> cannot be resolved`), or the daemon-on and
    // in-process violation sets diverge.
    expect(
      daemonDependencyMessage(
        '/project/file.ts',
        './missing',
        true,
        'source code',
      ),
    ).toBe('import ./missing cannot be resolved');
    expect(
      daemonEncapsulationMessage(
        '/project/file.ts',
        './missing',
        false,
        'source code',
      ),
    ).toBe('import ./missing cannot be resolved');
  });

  it('never throws on a malformed daemon result and falls back in-process', () => {
    process.env['SHERIFF_DAEMON'] = '1';
    // A violation missing `toTags` would throw in `toTags.join` if unguarded.
    const malformed = {
      dependencyRuleViolations: [{ fromTag: 'feature', rawImport: '@app/x' }],
      encapsulationViolations: [],
      externalRuleViolations: [],
    } as unknown as DaemonLintResult;
    synckitMocks.createSyncFn.mockReturnValue(vi.fn(() => malformed));

    // undefined => the rule falls back to its in-process check; no throw, no
    // spurious "(internal error)" diagnostic.
    expect(() =>
      daemonDependencyMessage('/project/file.ts', '@app/x', true, 'source'),
    ).not.toThrow();
    expect(
      daemonDependencyMessage('/project/file.ts', '@app/x', true, 'source'),
    ).toBeUndefined();
    // A malformed response is treated as a bridge failure and disables it.
    expect(isDaemonBridgeEnabled()).toBe(false);
  });
});
