/**
 * P0-20260708 · 场景化空态契约锁（产品评审 P0-3）。
 *
 * P0-3 场景化空态：descriptor.emptyState 声明 title/subtitle i18n key → ChatView 首屏用场景引导
 *      替代通用「选择一个智能体」。
 *
 * 注：P0-2（抽象模型标签）按用户决定撤销——会话框（composer）与普通会话保持统一，模型标签全局一致，
 *     故这里不再声明/断言 managedModel。
 *
 * 本测试锁「契约声明 + i18n key 三语可解析」；ChatView 模板接线由类型检查 + ChatView 测试兜底。
 */
import { describe, it, expect } from 'vitest'
import { createI18n } from 'vue-i18n'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'
import k12Zh from '../i18n/zh-CN'
import k12En from '../i18n/en'
import k12Ug from '../i18n/ug-CN'

describe('P0-20260708 场景空态契约', () => {
  it('P0-3 · K12 descriptor 声明 emptyState 且指向 k12.emptyState.*', () => {
    expect(K12_VIEW_DESCRIPTOR.emptyState?.titleKey).toBe('k12.emptyState.title')
    expect(K12_VIEW_DESCRIPTOR.emptyState?.subtitleKey).toBe('k12.emptyState.subtitle')
  })

  it('P0-2 撤销 · descriptor 不声明 managedModel（会话框与普通会话统一）', () => {
    expect((K12_VIEW_DESCRIPTOR.composer as { managedModel?: boolean } | undefined)?.managedModel).toBeUndefined()
  })

  it('k12.emptyState.* 在三语均可解析（无裸 key 泄漏）', () => {
    const locales: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['zh-CN', zhCN as never, k12Zh as never],
      ['en', enUS as never, k12En as never],
      ['ug-CN', ugCN as never, k12Ug as never],
    ]
    for (const [loc, base, k12] of locales) {
      const i18n = createI18n({ legacy: false, locale: loc, messages: { [loc]: { ...base, k12 } } })
      const tr = i18n.global.t as (k: string) => string
      const title = tr(K12_VIEW_DESCRIPTOR.emptyState!.titleKey)
      const sub = tr(K12_VIEW_DESCRIPTOR.emptyState!.subtitleKey)
      expect(title, `${loc} title 应有翻译`).not.toBe(K12_VIEW_DESCRIPTOR.emptyState!.titleKey)
      expect(sub, `${loc} subtitle 应有翻译`).not.toBe(K12_VIEW_DESCRIPTOR.emptyState!.subtitleKey)
    }
  })
})
