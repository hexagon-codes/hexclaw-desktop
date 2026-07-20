import { defineConfig, devices } from '@playwright/test'

import chromiumFixtureConfig, { k12FixtureTestMatch } from './playwright.k12.fixtures.config'

export const K12_FIXTURE_WEBKIT_REPORT_PATH = 'test-results/k12-fixtures-webkit/report.json'

/**
 * The WebKit Fixture lane reuses the frozen seven-file current-source contract,
 * but owns a distinct engine project and artifact/report tree.
 */
export default defineConfig({
  ...chromiumFixtureConfig,
  testMatch: k12FixtureTestMatch,
  outputDir: 'test-results/k12-fixtures-webkit/artifacts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/k12-fixtures-webkit/html' }],
    ['json', { outputFile: K12_FIXTURE_WEBKIT_REPORT_PATH }],
  ],
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
})
