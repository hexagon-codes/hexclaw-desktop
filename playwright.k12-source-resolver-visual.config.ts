import { defineConfig, devices } from '@playwright/test'

const runID = `${process.pid}`

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/k12-source-resolver-visual.spec.ts',
  timeout: 5 * 60_000,
  expect: {
    timeout: 20_000,
  },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir:
    process.env.HEX_SOURCE_RESOLVER_PW_OUTPUT?.trim() ||
    `/tmp/hexclaw-source-resolver-playwright-${runID}`,
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
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: [
    {
      command:
        'python3 -m http.server 16070 --bind 127.0.0.1 --directory /Users/guoyanjun/work/hexclaw-docs/prototype',
      url: 'http://127.0.0.1:16070/app.html',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 16061',
      url: 'http://127.0.0.1:16061',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
