import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // webkit-feel 走专用 playwright.webkit.config.ts（WebKit 引擎 + 自带 webServer），本默认配置不跑它
  testIgnore: ['**/browser-live-*.spec.ts', '**/webkit-*.spec.ts'],
  timeout: 180_000,
  retries: 0,
  workers: 1, // 串行执行，共享 sidecar 状态
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173', // Vite 前端；API 测试通过 helpers.ts BASE_URL 直连 sidecar 16060
    trace: 'on-first-retry',
  },
})
