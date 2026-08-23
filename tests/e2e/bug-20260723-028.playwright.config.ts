import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prototypeRoot = path.resolve(desktopRoot, '../hexclaw-docs/prototype')
const sourcePort = Number(process.env.HEX_BUG028_SOURCE_PORT)
const referencePort = Number(process.env.HEX_BUG028_REFERENCE_PORT)

if (!Number.isInteger(sourcePort) || !Number.isInteger(referencePort)) {
  throw new Error('BUG-20260723-028 visual gate requires caller-owned dynamic ports')
}

export default defineConfig({
  testDir: '.',
  testMatch: 'bug-20260723-028-modal-form-visual.spec.ts',
  timeout: 120_000,
  expect: { timeout: 8_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    actionTimeout: 8_000,
    navigationTimeout: 20_000,
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
  ],
  outputDir: '/tmp/hexclaw-bug-20260723-028-playwright/results',
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
