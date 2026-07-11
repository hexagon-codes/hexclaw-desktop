/**
 * BUG-20260708 装机反馈 · 会话→Agent 绑定持久化 + 恢复。
 *
 * 症状（真机截图）：从「进入辅导」深链进入 K12 会话是 K12 专属会话框；切到别的会话再切回，
 * 变成普通会话框、回复人设退化成默认「小蟹」。根因：agentRole 只临时态、从不持久化，
 * selectSession 又主动清空；后端 session 记录 agent_name/role 全为 null（不存绑定）。
 *
 * 修复：前端 localStorage 持久化 session→agent 绑定（同 session-model-binding），selectSession
 * 从绑定恢复；老会话无绑定时用标题（深链把标题设为 agent 内部名）兜底解析。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import {
  bindSessionAgent, getSessionAgent, clearSessionAgent, pruneSessionAgents,
} from '../session-agent-binding'
import SessionList from '@/components/chat/SessionList.vue'
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

describe('BUG-20260708 session-agent-binding 模块', () => {
  beforeEach(() => localStorage.clear())

  it('bind/get/clear 往返', () => {
    expect(getSessionAgent('s1')).toBe('')
    bindSessionAgent('s1', 'k12-tutor-KKE5v8zQ')
    expect(getSessionAgent('s1')).toBe('k12-tutor-KKE5v8zQ')
    clearSessionAgent('s1')
    expect(getSessionAgent('s1')).toBe('')
  })

  it('空 agentName = 清除绑定（不把默认助理会话误绑）', () => {
    bindSessionAgent('s1', 'k12-tutor-x')
    bindSessionAgent('s1', '')
    expect(getSessionAgent('s1')).toBe('')
  })

  it('prune 丢弃已不存在会话的绑定（防 localStorage 膨胀）', () => {
    bindSessionAgent('s1', 'a'); bindSessionAgent('s2', 'b'); bindSessionAgent('s3', 'c')
    pruneSessionAgents(['s1', 's3'])
    expect(getSessionAgent('s1')).toBe('a')
    expect(getSessionAgent('s2')).toBe('')
    expect(getSessionAgent('s3')).toBe('c')
  })
})

describe('BUG-20260708 会话列表显示名（真机截图：agent_name 为 null、标题=agent id）', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  function mountList(session: Partial<ChatSession>) {
    const pinia = createPinia(); setActivePinia(pinia)
    const chat = useChatStore(); const agents = useAgentsStore()
    agents.registeredAgents = [
      { name: 'k12-tutor-KKE5v8zQ', display_name: '小明的辅导老师 · 五年级', metadata: { scenario: 'k12-tutor' } },
    ] as never
    chat.sessions = [{ id: 'S1', created_at: '2026-07-08T10:00:00Z', updated_at: '2026-07-08T10:00:00Z', message_count: 2, ...session } as ChatSession]
    chat.currentSessionId = 'S1'
    return mount(SessionList, { global: { plugins: [pinia, i18n()], stubs: { ContextMenu: { template: '<div/>' } } } })
  }

  it('后端不返 agent_name，但标题=agent 内部名 → 显示 display_name（这是截图里没修好的场景）', () => {
    const w = mountList({ title: 'k12-tutor-KKE5v8zQ', agent_name: undefined })
    expect(w.find('.hc-sessions__title').text()).toBe('小明的辅导老师 · 五年级')
    expect(w.text()).not.toContain('k12-tutor-KKE5v8zQ')
  })

  it('localStorage 绑定存在时，即使标题被改名仍能识别 Agent（抗改名）——但改名保留自定义标题', () => {
    bindSessionAgent('S1', 'k12-tutor-KKE5v8zQ')
    const w = mountList({ title: '周三数学复习', agent_name: undefined })
    // 用户改过名 → 保留自定义标题（不强制覆盖成 display_name）
    expect(w.find('.hc-sessions__title').text()).toBe('周三数学复习')
  })
})
