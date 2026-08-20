import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'
import zhCN from '@/i18n/locales/zh-CN'

const locales = { 'zh-CN': zhCN, en, 'ug-CN': ugCN } as const
const requiredKeys = ['authorityReading', 'syncingStatus', 'enhancing'] as const

function reindexMessages(messages: (typeof locales)[keyof typeof locales]) {
  return {
    authorityReading: messages.knowledge.authorityReading,
    syncingStatus: messages.knowledge.syncingStatus,
    enhancing: messages.knowledge.semanticIndex.enhancing,
  }
}

describe('KnowledgeView reindex status locale contract', () => {
  for (const [locale, messages] of Object.entries(locales)) {
    it(`defines the exact reindex status key set in ${locale}`, () => {
      const values = reindexMessages(messages)
      expect(Object.keys(values)).toEqual(requiredKeys)
      expect(Object.values(values).every((value) => value.trim().length > 0)).toBe(true)
    })
  }

  it('does not fall back to Chinese for English or Uyghur reindex status copy', () => {
    for (const locale of ['en', 'ug-CN'] as const) {
      expect(Object.values(reindexMessages(locales[locale])).join('')).not.toMatch(/[\u3400-\u9fff]/)
    }
  })
})
