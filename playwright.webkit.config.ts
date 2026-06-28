import { defineConfig, devices } from '@playwright/test'

/**
 * 真机手感（WebKit）专用配置 —— 在 Apple WebKit 引擎里跑，这与 Tauri macOS 壳的 WKWebView 同引擎家族。
 * 其它 e2e 配置全用 Desktop Chrome(Chromium)，照不出「Chromium 正常但 WKWebView 翻车」这类引擎特异回归
 * （CSS calc/锚点、ResizeObserver、scrollIntoView 平滑滚动等）。本配置专补这块。
 *
 * 自包含：webServer 自动起 Vite（已起则复用）。前置：`npx playwright install webkit`。
 * 跑：`pnpm test:webkit-feel`
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/webkit-*.spec.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Safari'], // WebKit 引擎
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
