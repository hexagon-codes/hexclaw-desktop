import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { open as shellOpen } from '@tauri-apps/plugin-shell'

import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { createPersistPlugin } from './stores/plugins/persist'
import { logger } from './utils/logger'

import './assets/styles/global.css'

const app = createApp(App)

// Pinia + 持久化插件
const pinia = createPinia()
pinia.use(createPersistPlugin())
app.use(pinia)

app.use(router)
app.use(i18n)

app.config.errorHandler = (err, _instance, info) => {
  logger.error(`Vue 未处理异常 [${info}]:`, err)
}

window.addEventListener('unhandledrejection', (event) => {
  logger.error('未处理的 Promise 拒绝:', event.reason)
})

app.mount('#app')

// Open external links in system browser instead of the webview
document.addEventListener('click', (e) => {
  const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('/')) return
  e.preventDefault()
  shellOpen(href).catch(() => window.open(href, '_blank'))
})

// 移除启动 splash screen
const splash = document.getElementById('splash-screen')
if (splash) {
  splash.classList.add('fade-out')
  splash.addEventListener('transitionend', () => splash.remove(), { once: true })
}
