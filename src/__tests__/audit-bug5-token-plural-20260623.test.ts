import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

// AUDIT bug#5 2026-06-23：会话框顶部 token 计量单位应统一为复数 "tokens"（计数名词的业界惯例：
// OpenAI / Anthropic 控制台均显示 "N tokens"）。修复前 en="≈ {n} tokens"（复数）而 zh/ug="≈ {n} token"（单数），
// 三语不一致。token 仍保留英文小写不翻译。
type Dict = { chat: { aboutTokens: string } }

describe('AUDIT bug#5 token 计量单位统一为 tokens（复数）', () => {
  const cases: Array<[string, Dict]> = [
    ['zh-CN', zhCN as unknown as Dict],
    ['en', enUS as unknown as Dict],
    ['ug-CN', ugCN as unknown as Dict],
  ]
  for (const [name, dict] of cases) {
    it(`${name} chat.aboutTokens 用复数 "tokens"`, () => {
      const v = dict.chat.aboutTokens
      expect(v).toContain('{n}')
      // 必须是复数 tokens（计数单位惯例），且不出现"词元"中文翻译
      expect(v).toMatch(/\btokens\b/)
      expect(v).not.toContain('词元')
    })
  }
})
