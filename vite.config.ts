import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Tauri 开发时需要的配置
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 代码高亮语言包已按需懒加载，个别静态语言块天然偏大；
    // 同时继续把 PDF/XLSX/Markdown 相关重依赖拆出，避免主包继续膨胀。
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/vue/') || id.includes('/vue-router/') || id.includes('/pinia/') || id.includes('/vue-i18n/')) {
            return 'vendor-vue'
          }
          if (id.includes('pdfjs-dist')) return 'vendor-pdfjs'
          if (id.includes('/xlsx/')) return 'vendor-xlsx'
          if (id.includes('/mammoth/')) return 'vendor-docx'
          if (id.includes('markdown-it') || id.includes('dompurify')) return 'vendor-markdown'
          if (id.includes('naive-ui')) return 'vendor-naive-ui'
        },
      },
    },
  },
  // Tauri: 阻止 vite 遮挡 Rust 错误
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    proxy: {
      '/_hexclaw': {
        target: 'http://127.0.0.1:16060',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/_hexclaw/, ''),
      },
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // Tauri: 生产构建使用相对路径
  envPrefix: ['VITE_', 'TAURI_'],
})
