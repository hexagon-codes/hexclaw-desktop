import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

const REQUIRED_STATUS_KEYS = [
  'settings.status.title',
  'settings.status.loadData',
  'settings.status.budget',
  'settings.status.toolCache',
  'settings.status.toolMetrics',
  'settings.status.toolPermissions',
  'settings.status.toolName',
  'settings.status.toolCalls',
  'settings.status.toolSuccessRate',
  'settings.status.toolLatency',
  'settings.status.refresh',
]

describe('Settings status i18n coverage', () => {
  it('zh-CN locale defines every Settings status key used by the page', () => {
    const missing = REQUIRED_STATUS_KEYS.filter((path) => getByPath(zhCN, path) == null)
    expect(missing).toEqual([])
  })

  it('en locale defines every Settings status key used by the page', () => {
    const missing = REQUIRED_STATUS_KEYS.filter((path) => getByPath(en, path) == null)
    expect(missing).toEqual([])
  })
})
