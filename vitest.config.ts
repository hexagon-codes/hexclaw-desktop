import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: [fileURLToPath(new URL('./src/test/vitest-setup.ts', import.meta.url))],
      // Node's built-in test runner owns the mock/fixture contract suites.
      // Keeping them out of jsdom prevents Vite from trying to browser-bundle
      // node:test and preserves the explicit `pnpm mock:validate` boundary.
      exclude: [...configDefaults.exclude, 'e2e/**', 'tests/e2e/**', 'tests/**/*.test.mjs'],
      root: fileURLToPath(new URL('./', import.meta.url)),
      retry: process.env.CI ? 2 : 0,
    },
  }),
)
