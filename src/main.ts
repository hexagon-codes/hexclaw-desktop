import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { open as shellOpen } from '@tauri-apps/plugin-shell'

import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { createPersistPlugin } from './stores/plugins/persist'
import { logger } from './utils/logger'
import { installInputAutofixOff } from './utils/input-autofix'
import { registerK12Scenario } from './features/k12'

import './assets/styles/global.css'

const app = createApp(App)

// Pinia + 持久化插件
const pinia = createPinia()
pinia.use(createPersistPlugin())
app.use(pinia)

app.use(router)
app.use(i18n)

// 装配 K12 场景包（声明式注册 i18n/schema/descriptor 进 registry；模式关掉即随皮肤消失，AP-1）
registerK12Scenario()

app.config.errorHandler = (err, _instance, info) => {
  logger.error(`Vue 未处理异常 [${info}]:`, err)
}

window.addEventListener('unhandledrejection', (event) => {
  logger.error('未处理的 Promise 拒绝:', event.reason)
})

app.mount('#app')

// 全局关闭 WKWebView 原生「自动改写/自动纠正/首字母大写」：桌面端跑在 macOS WKWebView，
// 文本框默认会把 SQL / 主机名 / token 等技术输入悄悄改写（如 selecy→Select、首字母强制大写）。
// 统一对文本类 input/textarea 补 autocorrect=off/spellcheck=false/autocapitalize=off（bug-20260626）。
installInputAutofixOff()

// Open external links in system browser instead of the webview
document.addEventListener('click', (e) => {
  const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('/')) return
  e.preventDefault()
  shellOpen(href).catch(() => window.open(href, '_blank'))
})

// splash screen 由 AppLayout 在 sidecar 就绪后移除，见 dismissSplash()
