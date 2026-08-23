import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prototypeRoot = path.resolve(desktopRoot, '../hexclaw-docs/prototype')
const sourcePort = Number(process.env.HEX_BUG002_SOURCE_PORT)
const referencePort = Number(process.env.HEX_BUG002_REFERENCE_PORT)

if (!Number.isInteger(sourcePort) || !Number.isInteger(referencePort)) {
  throw new Error('BUG-20260729-002 visual gate requires caller-owned dynamic ports')
}

export default defineConfig({
  testDir: '.',
  testMatch: 'bug-20260729-002-global-typography-visual.spec.ts',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
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
