import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vitest } from 'vitest';
import { verify } from '../cli/verify';
import { mockCli } from '../cli/tests/helpers/mock-cli';
import {
  createSyntheticProject,
  SyntheticProjectOptions,
} from '../test/synthetic-project';

const runTimingSpecs = process.env['SHERIFF_PERF'] === '1';

describe.runIf(runTimingSpecs)('verify performance scaling', () => {
  afterEach(() => {
    // `mockCli` replaces process-exit callbacks with spies.
    vitest.restoreAllMocks();
  });

  it('stays linear-ish when the virtual project grows from N to 4N files', () => {
    mockCli();

    // Prime TypeScript parsing, config evaluation, and module resolution
    // before collecting samples.
    measureVerify({
      domains: 2,
      modulesPerDomain: 3,
      filesPerModule: 3,
    });

    const smallMs = median(
      measureSamples({
        domains: 20,
        modulesPerDomain: 3,
        filesPerModule: 6,
      }),
    );
    const largeMs = median(
      measureSamples({
        domains: 80,
        modulesPerDomain: 3,
        filesPerModule: 6,
      }),
    );

    // Linear work is approximately 4x. The old per-file scan of every
    // module was approximately 16x, leaving a broad margin for local load.
    expect(largeMs / smallMs).toBeLessThan(8);
  }, 60_000);
});

function measureSamples(options: SyntheticProjectOptions): number[] {
  return Array.from({ length: 3 }, () => measureVerify(options));
}

function measureVerify(options: SyntheticProjectOptions): number {
  createSyntheticProject(options);
  const startedAt = performance.now();
  verify(['src/main.ts']);
  return performance.now() - startedAt;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}
