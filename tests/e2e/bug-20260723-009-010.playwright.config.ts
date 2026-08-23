import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prototypeRoot = path.resolve(desktopRoot, '../hexclaw-docs/prototype')
const sourceRoot = process.env.HEX_CAPABILITY_SOURCE_ROOT?.trim()
const sourcePort = Number(process.env.HEX_CAPABILITY_SOURCE_PORT)
const referencePort = Number(process.env.HEX_CAPABILITY_REFERENCE_PORT)

if (!sourceRoot || !Number.isInteger(sourcePort) || !Number.isInteger(referencePort)) {
  throw new Error('capability visual gate requires a caller-owned build and two dynamic ports')
}

export default defineConfig({
  testDir: '.',
  testMatch: 'bug-20260723-009-010-paired-visual.spec.ts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: '/tmp/hexclaw-bug-20260723-009-010-results',
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `python3 -m http.server ${sourcePort} --bind 127.0.0.1`,
      cwd: sourceRoot,
      url: `http://127.0.0.1:${sourcePort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `python3 -m http.server ${referencePort} --bind 127.0.0.1`,
      cwd: prototypeRoot,
      url: `http://127.0.0.1:${referencePort}/app.html`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
