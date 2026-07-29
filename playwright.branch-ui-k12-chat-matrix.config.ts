import { defineConfig, devices } from '@playwright/test'

const runID = `${process.pid}`

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/branch-ui-k12-chat-matrix.spec.ts',
  timeout: 15 * 60_000,
  expect: {
    timeout: 15_000,
  },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: process.env.HEX_UI_PW_OUTPUT?.trim() || `/tmp/hexclaw-k12-chat-playwright-${runID}`,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder:
          process.env.HEX_UI_REPORT_ROOT?.trim() || `/tmp/hexclaw-k12-chat-report-${runID}`,
        open: 'never',
      },
    ],
  ],
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
