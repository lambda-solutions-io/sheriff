import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/sheriff-engine/tests/built-cli-engine.integration.spec.mjs',
    ],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
