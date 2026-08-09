import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

// 单元测试只来自前端源码与现有的纯函数门禁，禁止从打包产物反向发现测试。
const unitTestInclude = [
  'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
  'tests/gates/**/*.test.ts',
]

// 即使未来调整 include，也必须继续显式隔离所有可再生成的构建与测试制品。
const buildArtifactExclude = [
  'dist/**',
  'src-tauri/target/**',
  'coverage/**',
  'playwright-report*/**',
  'test-results/**',
]

export default defineConfig((configEnvironment) =>
  mergeConfig(
    viteConfig(configEnvironment),
    defineConfig({
      test: {
        environment: 'jsdom',
        setupFiles: [fileURLToPath(new URL('./src/test/vitest-setup.ts', import.meta.url))],
        include: unitTestInclude,
        // Node's built-in runner owns mock/fixture contracts, while Playwright
        // owns current-source, installed-RC and LIVE browser suites. Keeping all
        // of those out of jsdom prevents a unit run from collecting a second,
        // zero-environment copy of the release gates.
        exclude: [
          ...configDefaults.exclude,
          ...buildArtifactExclude,
          'e2e/**',
          'tests/e2e/**',
          'tests/live/**',
          'tests/**/*.test.mjs',
        ],
        root: fileURLToPath(new URL('./', import.meta.url)),
        retry: process.env.CI ? 2 : 0,
      },
    }),
  ),
)
