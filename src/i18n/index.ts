import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import en from './locales/en'

export const i18n = createI18n({
  legacy: false,
  locale: localStorage.getItem('hc-locale') || 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    en,
  },
})

export function setLocale(locale: 'zh-CN' | 'en') {
  ;(i18n.global.locale as { value: string }).value = locale
  localStorage.setItem('hc-locale', locale)
  document.documentElement.lang = locale === 'zh-CN' ? 'zh' : 'en'
}
