import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DOCS_ROOT =
  process.env.HEXCLAW_DOCS_ROOT?.trim() || path.resolve(REPO_ROOT, '../hexclaw-docs')
const REFERENCE_URL =
  process.env.HEX_BUG_011_REFERENCE_URL?.trim() || 'http://127.0.0.1:16711/app.html'
const SOURCE_URL = process.env.HEX_BUG_011_SOURCE_URL?.trim() || 'http://127.0.0.1:16712'
const RUN_ROOT = '/tmp/hexclaw-bug-20260723-011-playwright'

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function loopbackPort(raw: string, label: string) {
  const parsed = new URL(raw)
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(`${label} must use 127.0.0.1`)
  }
  if (!parsed.port) throw new Error(`${label} must declare a port`)
  return parsed.port
}

const referencePort = loopbackPort(REFERENCE_URL, 'HEX_BUG_011_REFERENCE_URL')
const sourcePort = loopbackPort(SOURCE_URL, 'HEX_BUG_011_SOURCE_URL')

export default defineConfig({
  testDir: path.join(REPO_ROOT, 'tests/e2e'),
  testMatch: '**/bug-20260723-011-resource-row-visual.spec.ts',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: `${RUN_ROOT}/results`,
  reporter: [['list'], ['json', { outputFile: `${RUN_ROOT}/playwright-results.json` }]],
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
    screenshot: 'off',
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
      command: `python3 -m http.server ${referencePort} --bind 127.0.0.1 --directory ${shellQuote(path.join(DOCS_ROOT, 'prototype'))}`,
      cwd: REPO_ROOT,
      url: REFERENCE_URL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `pnpm dev --host 127.0.0.1 --port ${sourcePort} --strictPort`,
      cwd: REPO_ROOT,
      url: SOURCE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
