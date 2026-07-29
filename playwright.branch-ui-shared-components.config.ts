import { defineConfig } from '@playwright/test'

const RUN_ROOT = '/tmp/hexclaw-shared-components-playwright'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/branch-ui-shared-components-matrix.spec.ts',
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: `${RUN_ROOT}/results`,
  reporter: [
    ['list'],
    ['json', { outputFile: `${RUN_ROOT}/playwright-results.json` }],
    [
      'html',
      {
        outputFolder: `${RUN_ROOT}/report`,
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
    screenshot: 'off',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      },
    },
  ],
})
