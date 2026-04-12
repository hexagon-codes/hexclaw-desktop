import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/browser-live-*.spec.ts',
  timeout: 180_000,
  retries: 0,
  workers: 1, // 串行执行，共享 sidecar 状态
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173', // Vite 前端；API 测试通过 helpers.ts BASE_URL 直连 sidecar 16060
    trace: 'on-first-retry',
  },
})
