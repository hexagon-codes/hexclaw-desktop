import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/branch-ui-general-modals-matrix.spec.ts',
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: 'test-results/branch-ui-general-modals/playwright',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: 'test-results/branch-ui-general-modals/report',
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
    actionTimeout: 5_000,
    navigationTimeout: 12_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
