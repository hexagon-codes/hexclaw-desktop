import { defineConfig, devices } from '@playwright/test'

/**
 * Deterministic browser journeys for the semantic-index control plane.
 *
 * The backend and Ollama endpoints are intercepted by the spec, so this lane
 * never reads a developer credential, calls a paid provider, or mutates the
 * developer's Ollama installation.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/semantic-index-model-journeys.spec.ts',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5187',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'pnpm dev --host 127.0.0.1 --port 5187',
      url: 'http://127.0.0.1:5187',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'python3 -m http.server 16070 --bind 127.0.0.1 --directory ../hexclaw-docs/prototype',
      url: 'http://127.0.0.1:16070/app.html',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
