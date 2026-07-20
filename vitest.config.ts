import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: [fileURLToPath(new URL('./src/test/vitest-setup.ts', import.meta.url))],
      // Node's built-in runner owns mock/fixture contracts, while Playwright
      // owns current-source, installed-RC and LIVE browser suites. Keeping all
      // of those out of jsdom prevents a unit run from collecting a second,
      // zero-environment copy of the release gates.
      exclude: [
        ...configDefaults.exclude,
        'e2e/**',
        'tests/e2e/**',
        'tests/live/**',
        'tests/**/*.test.mjs',
      ],
      root: fileURLToPath(new URL('./', import.meta.url)),
      retry: process.env.CI ? 2 : 0,
    },
  }),
)
