import { readFileSync } from 'node:fs'

import { defineConfig, devices } from '@playwright/test'

interface CurrentBugLiveContract {
  schemaVersion: number
  reportPath: string
  specFile: string
  project: string
  submissions: { plannedTopLevel: number; maximumTopLevel: number }
}

const contract = JSON.parse(
  readFileSync(
    new URL('./tests/live/k12-current-bug-real-matrix.contract.json', import.meta.url),
    'utf8',
  ),
) as CurrentBugLiveContract

if (
  contract.schemaVersion !== 1 ||
  contract.specFile !== 'k12-current-bug-real-matrix.spec.ts' ||
  contract.project !== 'chromium' ||
  contract.submissions.plannedTopLevel > contract.submissions.maximumTopLevel
) {
  throw new Error('invalid K12 current-bug LIVE contract')
}

export default defineConfig({
  testDir: './tests/live',
  testMatch: [`**/${contract.specFile}`],
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: 'test-results/k12-current-bug-live/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: contract.reportPath }],
  ],
  use: {
    baseURL: process.env.HEX_K12_LIVE_APP_URL || 'http://127.0.0.1:1',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: contract.project, use: { ...devices['Desktop Chrome'] } }],
})
