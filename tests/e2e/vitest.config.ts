import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One file, tests run in order: later tests use what earlier ones created.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
