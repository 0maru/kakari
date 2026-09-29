import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 共有DBを使うため直列に実行する
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/global-setup.ts'],
  },
});
