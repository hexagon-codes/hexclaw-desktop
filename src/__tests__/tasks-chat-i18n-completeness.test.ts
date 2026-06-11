/**
 * Locale completeness for TasksView / ChatView additions.
 *
 * Review gap: keys introduced by the task-history and cron-compile-progress
 * work (runOutput / runErrorOutput / hideHistory / cron hints / delete
 * feedback) relied on zh-CN fallback if a locale missed them. Pin every key
 * in all three locales so a missing translation fails CI instead of silently
 * falling back.
 */
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

const LOCALES = { 'zh-CN': zhCN, en, 'ug-CN': ugCN } as const

/** Keys used by the TasksView / ChatView additions under review. */
const REQUIRED_KEYS = [
  // TasksView run history
  'tasks.runOutput',
  'tasks.runErrorOutput',
  'tasks.hideHistory',
  'tasks.history',
  'tasks.viewScript',
  'tasks.hideScript',
  // ChatView cron compile progress card
  'chat.cronStageStarting',
  'chat.cronCompileHint',
  // useChatActions delete-failure feedback (added with the review fixes)
  'chat.deleteMessageFailed',
] as const

function resolveKey(messages: Record<string, unknown>, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    messages,
  )
}

describe('tasks/chat additions exist in every locale', () => {
  for (const [localeName, messages] of Object.entries(LOCALES)) {
    for (const key of REQUIRED_KEYS) {
      it(`${localeName} defines ${key}`, () => {
        const value = resolveKey(messages as Record<string, unknown>, key)
        expect(typeof value, `${localeName} missing ${key}`).toBe('string')
        expect((value as string).trim().length, `${localeName} has empty ${key}`).toBeGreaterThan(0)
      })
    }
  }
})
