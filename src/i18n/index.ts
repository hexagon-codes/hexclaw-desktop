import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import en from './locales/en'
import ugCN from './locales/ug-CN'

/**
 * 支持的 locale。`ug-CN`（维吾尔语）v0.4.0 起支持，基础可用版 ——
 * 未翻译的 key 通过 fallbackLocale='zh-CN' 自动回落，不出现 missing 警告。
 */
export type AppLocale = 'zh-CN' | 'en' | 'ug-CN'

/** RTL（从右到左）方向显示的 locale 集合。 */
const RTL_LOCALES = new Set<AppLocale>(['ug-CN'])

export function isRTLLocale(locale: AppLocale): boolean {
  return RTL_LOCALES.has(locale)
}

export const i18n = createI18n({
  legacy: false,
  locale: (localStorage.getItem('hc-locale') as AppLocale | null) || 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    /** 部分环境 / 测试链会解析为 `zh`，与 zh-CN 共用文案 */
    zh: zhCN,
    en,
    'ug-CN': ugCN,
  },
})

/** v0.4.0：把 locale → HTML lang 属性的映射收敛到一处，新增 locale 在此扩展。 */
function htmlLangFor(locale: AppLocale): string {
  switch (locale) {
    case 'zh-CN':
      return 'zh'
    case 'en':
      return 'en'
    case 'ug-CN':
      return 'ug'
  }
}

export function setLocale(locale: AppLocale) {
  ;(i18n.global.locale as { value: string }).value = locale
  localStorage.setItem('hc-locale', locale)
  const root = document.documentElement
  root.lang = htmlLangFor(locale)
  // RTL 方向开关 —— 维吾尔语阿拉伯字母从右到左书写。
  // 通过 `dir` 属性触发全局 CSS logical properties (margin-inline-start/end) 自动镜像。
  root.dir = isRTLLocale(locale) ? 'rtl' : 'ltr'
}

// 启动时同步一次 dir / lang，避免首屏与 localStorage 已存的 locale 不一致。
if (typeof document !== 'undefined') {
  const initial = (localStorage.getItem('hc-locale') as AppLocale | null) || 'zh-CN'
  const root = document.documentElement
  root.lang = htmlLangFor(initial)
  root.dir = isRTLLocale(initial) ? 'rtl' : 'ltr'
}
