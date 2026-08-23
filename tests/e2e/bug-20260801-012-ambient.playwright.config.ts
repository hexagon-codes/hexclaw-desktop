import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prototypeRoot = path.resolve(desktopRoot, '../hexclaw-docs/prototype')
const sourcePort = Number(process.env.HEX_K12_AMBIENT_SOURCE_PORT)
const referencePort = Number(process.env.HEX_K12_AMBIENT_REFERENCE_PORT)

if (!Number.isInteger(sourcePort) || !Number.isInteger(referencePort)) {
  throw new Error('isolated BUG-20260801-012 visual gate requires two caller-owned dynamic ports')
}

export default defineConfig({
  testDir: '.',
  testMatch: 'bug-20260801-012-ambient-current-source.spec.ts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    viewport: { width: 2048, height: 924 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
