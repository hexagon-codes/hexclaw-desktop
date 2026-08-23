import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const fixtureDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: '@tauri-apps/api/core',
        replacement: resolve(fixtureDir, 'traced-tauri-core.ts'),
      },
      {
        find: '__BUG013_ACTUAL_TAURI_CORE__',
        replacement: resolve(fixtureDir, '../../../node_modules/@tauri-apps/api/core.js'),
      },
      { find: '@', replacement: resolve(fixtureDir, '../../../src') },
    ],
  },
  build: {
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
})
