import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.HEX_E2E_BASE_URL || 'http://127.0.0.1:5173'
const artifactRoot = process.env.HEX_MOCK_ARTIFACT_DIR || 'test-results/mock-e2e'
const uiURL = new URL(baseURL)

if (uiURL.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(uiURL.hostname)) {
  throw new Error(`HEX_E2E_BASE_URL must be a loopback HTTP URL, received ${baseURL}`)
}
const uiHost = uiURL.hostname === 'localhost' ? '127.0.0.1' : uiURL.hostname
const uiPort = uiURL.port || '80'

/**
 * L4 mock lane: Browser UI + real Sidecar, backed by the local Docker mock stack.
 * This is deliberately not a native Tauri window test; native-window smoke tests
 * belong to the separate Tauri lane. The Sidecar must be started by the test
 * runtime and exposed through HEX_E2E_SIDECAR_URL—this config only starts Vite.
 */
export default defineConfig({
  globalSetup: './tests/mock/playwright.global-setup.ts',
  testDir: './tests/e2e',
  testMatch: '**/browser-mock-*.spec.ts',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  outputDir: `${artifactRoot}/playwright-output`,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${artifactRoot}/playwright-report` }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    channel: 'chrome',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `pnpm dev --host ${uiHost} --port ${uiPort} --strictPort`,
    url: baseURL,
    reuseExistingServer: process.env.HEX_E2E_REUSE_UI === '1',
    timeout: 120_000,
  },
})
