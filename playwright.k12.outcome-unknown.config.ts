import { defineConfig, devices } from '@playwright/test'

const artifactRoot = 'test-results/k12-outcome-unknown'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/k12-outcome-unknown.browser.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  outputDir: `${artifactRoot}/playwright-output`,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${artifactRoot}/playwright-report` }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
