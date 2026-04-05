import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

const REQUIRED_CHAT_COMPONENT_KEYS = [
  'chat.budget',
  'chat.toolApproval',
  'chat.alwaysAllow',
  'chat.deny',
  'chat.approve',
  'chat.approvalResponded',
]

describe('Chat component i18n coverage', () => {
  it('zh-CN locale defines every chat-component key used by shared chat widgets', () => {
    const missing = REQUIRED_CHAT_COMPONENT_KEYS.filter((path) => getByPath(zhCN, path) == null)
    expect(missing).toEqual([])
  })

  it('en locale defines every chat-component key used by shared chat widgets', () => {
    const missing = REQUIRED_CHAT_COMPONENT_KEYS.filter((path) => getByPath(en, path) == null)
    expect(missing).toEqual([])
  })
})
