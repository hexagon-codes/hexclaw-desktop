import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

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

  // 对齐原型 app.html：知识库页第一个分段 tab 文案是「文档」而非顶层「知识库」，
  // 避免与侧栏一级入口「知识库」重名（nav.knowledge 仍为「知识库」）。
  it('knowledge first sub-tab label is "Documents" (proto-aligned), distinct from nav.knowledge', () => {
    expect(getByPath(zhCN, 'nav.knowledgeDocs')).toBe('文档')
    expect(getByPath(zhCN, 'nav.knowledge')).toBe('知识库')
    expect(getByPath(en, 'nav.knowledgeDocs')).toBe('Documents')
    // ug 三语一致性：也应区分（文档 ≠ 知识库）
    expect(getByPath(ugCN, 'nav.knowledgeDocs')).not.toBe(getByPath(ugCN, 'nav.knowledge'))
  })
})
