import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/branch-ui-k12-records-matrix.spec.ts',
  timeout: 600_000,
  expect: {
    timeout: 15_000,
  },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: '/tmp/hexclaw-k12-records-matrix-playwright',
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
