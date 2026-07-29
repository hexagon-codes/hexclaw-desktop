import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    '**/branch-ui-fidelity.spec.ts',
    '**/branch-ui-background-matrix.spec.ts',
    '**/connections-background-fidelity.spec.ts',
  ],
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: 'test-results/branch-ui-fidelity/playwright',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/branch-ui-fidelity/report', open: 'never' }],
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
