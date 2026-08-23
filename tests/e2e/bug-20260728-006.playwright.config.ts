import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '../..')
const prototypeRoot = resolve(desktopRoot, '../hexclaw-docs/prototype')

export default defineConfig({
  testDir: '.',
  testMatch: 'bug-20260728-006-profile-authority.spec.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
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
  webServer: [
    {
      command: `python3 -m http.server 16126 --bind 127.0.0.1 --directory ${JSON.stringify(prototypeRoot)}`,
      url: 'http://127.0.0.1:16126/app.html',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 16127 --strictPort',
      cwd: desktopRoot,
      url: 'http://127.0.0.1:16127/agents',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
