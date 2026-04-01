import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  retries: 0,
  workers: 1, // 串行执行，共享 sidecar 状态
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:16060',
    trace: 'on-first-retry',
  },
})
