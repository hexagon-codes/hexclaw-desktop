/**
 * P0-20260708 · 会话列表显示名（产品评审 P0-1）。
 *
 * 症状：场景会话（辅导老师）在会话列表显示原始 agent id `k12-tutor-KKE5v8zQ`，家长看不懂、
 * 一眼「给程序员用的」。根因：自动创建的会话 title 默认 = 原始 agent name。
 *
 * 修复：SessionList 据 session.agent_name 解析 agent 的 display_name，当 title 缺省或恰为原始 id 时
 * 显示 display_name（用户手动改名则保留）。回归锁：列表不得出现原始 id、应显示可读名。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import type { ChatSession } from '@/types'

vi.mock('@/api/chat', () => ({
  updateSessionTitle: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0, query: '' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  getSessionBranches: vi.fn().mockResolvedValue({ branches: [], total: 0 }),
}))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

function mountWith(sessionTitle: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chat = useChatStore()
  const agents = useAgentsStore()
  agents.registeredAgents = [
    { name: 'k12-tutor-KKE5v8zQ', display_name: '小明的辅导老师 · 五年级', metadata: { scenario: 'k12-tutor' } },
  ] as never
  chat.sessions = [
    { id: 's-1', title: sessionTitle, agent_name: 'k12-tutor-KKE5v8zQ', created_at: '2026-07-08T10:00:00Z', updated_at: '2026-07-08T10:00:00Z', message_count: 1 } as ChatSession,
  ]
  chat.currentSessionId = 's-1'
  return mount(SessionList, { global: { plugins: [pinia, i18n()], stubs: { ContextMenu: { template: '<div/>' } } } })
}

describe('P0-20260708 会话列表显示名', () => {
  it('场景会话标题=原始 id 时，显示 agent 的 display_name（不泄漏 k12-tutor-xxx）', () => {
    const w = mountWith('k12-tutor-KKE5v8zQ')
    expect(w.find('.hc-sessions__title').text()).toBe('小明的辅导老师 · 五年级')
    expect(w.text()).not.toContain('k12-tutor-KKE5v8zQ')
  })

  it('用户手动改过名（title≠agent id）则保留自定义标题', () => {
    const w = mountWith('周三数学复习')
    expect(w.find('.hc-sessions__title').text()).toBe('周三数学复习')
  })
})
