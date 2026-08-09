import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/creative-real-fixtures.spec.ts',
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: process.env.HEX_K12_CREATIVE_DELETE_OUTPUT_DIR || '/tmp/hexclaw-k12-creative-delete-artifacts',
  reporter: [['list']],
  use: {
    baseURL: process.env.HEX_E2E_BASE_URL || 'http://127.0.0.1:5173',
    channel: 'chrome',
    ...devices['Desktop Chrome'],
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'system-chrome', use: {} }],
})
