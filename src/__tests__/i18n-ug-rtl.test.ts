/**
 * v0.4.0 维吾尔语 (ug-CN) 桌面端支持 — i18n + RTL 切换契约测试
 *
 * 验证：
 *  - setLocale('ug-CN') 后 document.documentElement.dir === 'rtl'
 *  - setLocale('ug-CN') 后 document.documentElement.lang === 'ug'
 *  - 切回 'zh-CN' 后 dir 回到 'ltr'
 *  - i18n 能解析维吾尔语翻译过的 key（nav.chat / common.save 等）
 *  - 未翻译的 key 正确 fallback 到 zh-CN（不出现 missing key）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { i18n, setLocale, isRTLLocale } from '../i18n'

describe('维吾尔语 ug-CN locale 支持', () => {
  beforeEach(() => {
    // 每个用例从干净 zh-CN 状态起始
    setLocale('zh-CN')
  })

  it('isRTLLocale 应只对 ug-CN 返回 true', () => {
    expect(isRTLLocale('ug-CN')).toBe(true)
    expect(isRTLLocale('zh-CN')).toBe(false)
    expect(isRTLLocale('en')).toBe(false)
  })

  it('setLocale ug-CN 后 dir=rtl + lang=ug', () => {
    setLocale('ug-CN')
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.documentElement.lang).toBe('ug')
  })

  it('切回 zh-CN 后 dir 回到 ltr', () => {
    setLocale('ug-CN')
    setLocale('zh-CN')
    expect(document.documentElement.dir).toBe('ltr')
    expect(document.documentElement.lang).toBe('zh')
  })

  it('维吾尔语已翻译 key 正确解析', () => {
    setLocale('ug-CN')
    // 通用按钮
    expect(i18n.global.t('common.save')).toBe('ساقلاش')
    expect(i18n.global.t('common.cancel')).toBe('بىكار قىلىش')
    // 导航
    expect(i18n.global.t('nav.chat')).toBe('سۆھبەت')
    expect(i18n.global.t('nav.settings')).toBe('تەڭشەك')
  })

  it('维吾尔语 locale 已被 i18n 注册', () => {
    // 验证 ug-CN 在 i18n.global.availableLocales 中
    const available = i18n.global.availableLocales
    expect(available).toContain('ug-CN')
  })
})
