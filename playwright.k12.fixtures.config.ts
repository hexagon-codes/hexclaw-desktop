import { readFileSync } from 'node:fs'

import { defineConfig, devices } from '@playwright/test'

interface K12FixtureGateContract {
  schemaVersion: number
  reportPath: string
  currentSource: {
    description: string
    endpoints: string[]
    managesWebServer: boolean
    managesSidecar: boolean
  }
  parentOwnedChildEnvironment: string[]
  specs: Array<{
    file: string
    tests: string[]
    zeroSkipGates: string[]
    fixtureOverrides: string[]
  }>
}

const contract = JSON.parse(
  readFileSync(new URL('./tests/e2e/k12-fixtures-gate.contract.json', import.meta.url), 'utf8'),
) as K12FixtureGateContract

if (
  contract.schemaVersion !== 2 ||
  contract.reportPath !== 'test-results/k12-fixtures/report.json' ||
  JSON.stringify(contract.parentOwnedChildEnvironment) !==
    '["HEX_K12_REAL_10X_CYCLE_ID","HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH","HEX_K12_REAL_10X_PARENT_RUN_ID"]'
) {
  throw new Error('invalid K12 Fixture gate contract version or report path')
}

const fixtureFiles = contract.specs.map(({ file }) => file)
if (
  fixtureFiles.length !== 7 ||
  new Set(fixtureFiles).size !== fixtureFiles.length ||
  fixtureFiles.some(
    (file) => typeof file !== 'string' || !/^[a-z0-9][a-z0-9-]*\.spec\.ts$/.test(file),
  )
) {
  throw new Error('K12 Fixture gate must contain exactly seven unique specs')
}

const fixtureTitles: string[] = []
const fixtureMembers = contract.specs.flatMap(({ file, tests }) => {
  if (
    !Array.isArray(tests) ||
    tests.length === 0 ||
    tests.some((title) => typeof title !== 'string' || !title.trim() || title !== title.trim())
  ) {
    throw new Error('K12 Fixture gate specs must declare non-empty canonical tests')
  }
  fixtureTitles.push(...tests)
  return tests.map((title) => `${file} › ${title}`)
})
if (
  new Set(fixtureTitles).size !== fixtureTitles.length ||
  new Set(fixtureMembers).size !== fixtureMembers.length
) {
  throw new Error('K12 Fixture gate canonical tests must be unique')
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const k12FixtureTestMatch = fixtureFiles.map(
  (file) => new RegExp(`[\\\\/]tests[\\\\/]e2e[\\\\/]${escapeRegExp(file)}$`),
)

/**
 * Current-source lane only:
 * - HEX_E2E_BASE_URL identifies the already-running Desktop UI.
 * - HEX_E2E_SIDECAR_URL is consumed by the specs/helpers for the already-running Sidecar.
 * - Each spec owns its HEX_K12_* opt-in gates listed in the contract.
 *
 * This config deliberately starts no UI, Sidecar, mock, or replacement service.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: k12FixtureTestMatch,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: 'test-results/k12-fixtures/artifacts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/k12-fixtures/html' }],
    ['json', { outputFile: contract.reportPath }],
  ],
  metadata: {
    currentSource: contract.currentSource,
    zeroSkipGatesBySpec: Object.fromEntries(
      contract.specs.map(({ file, zeroSkipGates }) => [file, zeroSkipGates]),
    ),
  },
  use: {
    baseURL: process.env.HEX_E2E_BASE_URL || 'http://127.0.0.1:5173',
    // These lanes load private child fixtures. Automatic trace/screenshot/video
    // archives would copy raw pages and model text into Playwright reports.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
