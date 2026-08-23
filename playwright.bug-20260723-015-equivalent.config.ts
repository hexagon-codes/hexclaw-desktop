import { defineConfig } from '@playwright/test'

const browserName = process.env.HEX_EQUIVALENT_BROWSER === 'webkit' ? 'webkit' : 'chromium'

export default defineConfig({
  testDir: '.',
  testMatch: 'tests/e2e/bug-20260723-015-equivalent-fixture.spec.ts',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName,
    baseURL: process.env.HEX_EQUIVALENT_SOURCE_URL || 'http://127.0.0.1:16061',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
  },
})
