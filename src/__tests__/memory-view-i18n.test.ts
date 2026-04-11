import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

const REQUIRED_MEMORY_KEYS = [
  'memory.readOnly',
  'memory.activeMemory',
  'memory.archivedMemory',
  'memory.allMemory',
  'memory.archived',
  'memory.archivedCount',
  'memory.loadedCount',
  'memory.loadMore',
  'memory.loadingMore',
  'memory.archiveMemory',
  'memory.restoreMemory',
  'memory.allTypes',
  'memory.allSources',
  'memory.sourceType.manual',
  'memory.sourceType.chat_explicit',
  'memory.sourceType.chat_extract',
  'memory.sourceType.system',
  'memory.deleteTitle',
  'memory.deleteMessage',
  'memory.archiveFailed',
  'memory.restoreFailed',
]

describe('MemoryView i18n coverage', () => {
  it('zh-CN locale defines every memory key used by MemoryView', () => {
    const missing = REQUIRED_MEMORY_KEYS.filter((path) => getByPath(zhCN, path) == null)
    expect(missing).toEqual([])
  })

  it('en locale defines every memory key used by MemoryView', () => {
    const missing = REQUIRED_MEMORY_KEYS.filter((path) => getByPath(en, path) == null)
    expect(missing).toEqual([])
  })
})
