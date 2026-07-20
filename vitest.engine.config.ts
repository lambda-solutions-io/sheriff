import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/sheriff-engine/tests/conformance.spec.mjs'],
    fileParallelism: false,
  },
});
