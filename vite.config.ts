import { isAbsolute } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const packageLocalMode = 'package-local'

export default defineConfig(({ mode }) => {
  const packageLocal = mode === packageLocalMode
  const packageLocalDistDirectory = packageLocal
    ? process.env.HEXCLAW_PACKAGE_LOCAL_DIST_DIR
    : undefined
  if (packageLocalDistDirectory && !isAbsolute(packageLocalDistDirectory)) {
    throw new Error('Package-local dist directory must be absolute')
  }
  // package-local 分支不得读取宿主开发变量；仅开发服务器按需读取。
  const developmentServer = packageLocal
    ? undefined
    : (() => {
        const host = process.env.TAURI_DEV_HOST
        const sidecarProxyTarget = process.env.HEX_E2E_SIDECAR_URL || 'http://127.0.0.1:16060'
        return {
          port: 5173,
          strictPort: true,
          host: host || false,
          hmr: host ? { protocol: 'ws' as const, host, port: 5174 } : undefined,
          proxy: {
            '/_hexclaw': {
              target: sidecarProxyTarget,
              changeOrigin: true,
              ws: true,
              rewrite: (path: string) => path.replace(/^\/_hexclaw/, ''),
            },
          },
          watch: {
            ignored: ['**/src-tauri/**'],
          },
        }
      })()

  return {
    // Tauri 生产页由自定义 asset 协议加载，构建产物必须使用相对路径。
    base: './',
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      outDir: packageLocalDistDirectory,
      // 代码高亮语言包已按需懒加载，个别静态语言块天然偏大；
      // 同时继续把 XLSX/Markdown 相关重依赖拆出，避免主包继续膨胀。
      // 文档内容抽取仍由后端完成；打印预览按需加载 PDF.js 及其同源 Worker，
      // 只解码冻结后的打印 PDF Blob，不进入首屏主包。
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (
              id.includes('/vue/') ||
              id.includes('/vue-router/') ||
              id.includes('/pinia/') ||
              id.includes('/vue-i18n/')
            ) {
              return 'vendor-vue'
            }
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
    server: developmentServer,
    // package-local 只消费代码内公开默认值，不能隐式读取开发者或宿主环境。
    envDir: packageLocal ? false : undefined,
    envPrefix: packageLocal ? ['HEXCLAW_PACKAGE_LOCAL_PUBLIC_'] : ['VITE_'],
  }
})
