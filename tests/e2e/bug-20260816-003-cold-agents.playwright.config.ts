import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prototypeRoot = path.resolve(desktopRoot, '../hexclaw-docs/prototype')
const sourcePort = Number(process.env.HEX_BUG_20260816_003_SOURCE_PORT || '27203')
const referencePort = Number(process.env.HEX_BUG_20260816_003_REFERENCE_PORT || '27213')

if (!Number.isInteger(sourcePort) || !Number.isInteger(referencePort)) {
  throw new Error('cold agents visual gate requires integer source/reference ports')
}

export default defineConfig({
  testDir: path.resolve(desktopRoot, 'tests/e2e'),
  testMatch: 'bug-20260816-003-cold-agents-visual.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: `/tmp/hexclaw-bug-20260816-003-cold-agents-playwright-${process.pid}`,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${sourcePort} --strictPort`,
      cwd: desktopRoot,
      url: `http://127.0.0.1:${sourcePort}`,
      reuseExistingServer: false,
      timeout: 120_000,
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
