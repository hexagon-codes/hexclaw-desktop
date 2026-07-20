import { defineConfig } from '@playwright/test'

const currentSourceEnvironment = [
  'HEX_E2E_BASE_URL',
  'HEX_E2E_SIDECAR_URL',
  'HEX_E2E_SIDECAR_WS_URL',
] as const
const listingOnly = process.argv.includes('--list')
const missingCurrentSourceEnvironment = currentSourceEnvironment.filter(
  (name) => !process.env[name]?.trim(),
)

if (!listingOnly && missingCurrentSourceEnvironment.length > 0) {
  throw new Error(
    'current-source requires explicit HEX_E2E_BASE_URL, HEX_E2E_SIDECAR_URL and HEX_E2E_SIDECAR_WS_URL',
  )
}

export const currentSourceTestMatch = [
  '**/api-chain.spec.ts',
  '**/streaming-chain.spec.ts',
  '**/browser-chat-background.spec.ts',
  '**/browser-clearable-inputs.spec.ts',
]

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: currentSourceTestMatch,
  timeout: 420_000,
  retries: 0,
  workers: 1, // 串行执行，共享 sidecar 状态
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // `--list` may use the inert value below because it never opens a browser.
    // Every executable current-source run is rejected above unless all three
    // endpoints identify the caller-owned, isolated UI and Sidecar.
    baseURL: process.env.HEX_E2E_BASE_URL || 'http://127.0.0.1:1',
    trace: 'on-first-retry',
  },
})
