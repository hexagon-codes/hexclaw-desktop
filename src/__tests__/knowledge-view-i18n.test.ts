import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

const REQUIRED_KNOWLEDGE_KEYS = [
  'knowledge.uploadFile',
  'knowledge.orManualInput',
]

describe('KnowledgeView i18n coverage', () => {
  it('zh-CN locale defines every knowledge key used by the add-document dialog', () => {
    const missing = REQUIRED_KNOWLEDGE_KEYS.filter((path) => getByPath(zhCN, path) == null)
    expect(missing).toEqual([])
  })

  it('en locale defines every knowledge key used by the add-document dialog', () => {
    const missing = REQUIRED_KNOWLEDGE_KEYS.filter((path) => getByPath(en, path) == null)
    expect(missing).toEqual([])
  })
})
