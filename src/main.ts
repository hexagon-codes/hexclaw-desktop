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
import HcClearableField from './components/common/HcClearableField.vue'

// KaTeX 是所有会话/场景富文本的基础样式，必须随入口 CSS 同步加载。
// WKWebView 对异步 Vue 组件 CSS chunk 的装载时序与 Chromium 不同；放在组件内会出现
// DOM 已渲染但分数布局样式尚未生效的塌散帧，甚至缓存后持续错位。
import 'katex/dist/katex.min.css'
import './assets/styles/global.css'

const app = createApp(App)
app.component('HcClearableField', HcClearableField)

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
	// 带 download 的链接是应用主动生成的文件下载（导出、批改 PNG 等），不是外链。
	// 若在这里 preventDefault + shellOpen，浏览器会打开 blob 图片新页，下载事件永远不发生。
	if (anchor.hasAttribute('download')) return
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('/')) return
  e.preventDefault()
  shellOpen(href).catch(() => window.open(href, '_blank'))
})

// splash screen 由 AppLayout 在 sidecar 就绪后移除，见 dismissSplash()
