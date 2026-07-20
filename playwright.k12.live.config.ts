import { defineConfig, devices } from '@playwright/test'

/**
 * Keep this list exact.  The release lane contains the three producer/surface
 * LIVE contracts plus the six stateful K12 acceptance journeys.  A broad
 * `**\/*.spec.ts` here would silently mix mock/source-server tests into the
 * installed-RC evidence.
 */
const k12LiveSpecs = [
  '**/live/k12-learning-records.spec.ts',
  '**/live/k12-chat-markdown-latex.spec.ts',
  '**/live/k12-dingtalk-markdown-latex.spec.ts',
  '**/e2e/learning-records-all-controls.spec.ts',
  '**/e2e/photo-degradation-matrix.spec.ts',
  '**/e2e/knowledge-real-pdf-lifecycle.spec.ts',
  '**/e2e/skill-lifecycle-recall.spec.ts',
  '**/e2e/workflow-trigger-rotation.spec.ts',
  '**/e2e/print-export-real.spec.ts',
]

export default defineConfig({
  testDir: './tests',
  testMatch: k12LiveSpecs,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: 'test-results/k12-live/artifacts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-k12-live' }],
    ['json', { outputFile: 'test-results/k12-live/report.json' }],
  ],
  use: {
    baseURL: process.env.HEX_K12_LIVE_APP_URL || 'http://127.0.0.1:1',
    // LIVE may render child data and real channel/model responses. Evidence is
    // attached explicitly after redaction; automatic raw archives stay disabled.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
})
