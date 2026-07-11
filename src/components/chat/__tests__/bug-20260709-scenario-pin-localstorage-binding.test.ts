/**
 * 审计单验证（20260709 · Medium）：场景会话自动置顶忽略 localStorage 绑定路径。
 *
 * SessionList.isScenarioSession() 在 s.agent_name 为空时直接 return false，
 * 但新的绑定设计（session-agent-binding，BUG-20260708）明确处理「后端 agent_name 为 null」
 * 的会话：getSessionAgent(s.id) / 标题即内部名 三路解析（boundAgentOf 已写但未被使用）。
 *
 * 影响：从 localStorage 绑定恢复的 K12 会话标题显示正常，但拿不到「场景会话常驻置顶」行为。
 *
 * 断言的是**正确行为**（绑定路径的场景会话进「已置顶」分区）——测试失败即证明 bug 存在。
 * 附对照用例：同一会话若后端带 agent_name 则能置顶（证明置顶机制本身工作，缺口只在绑定路径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { scenarioRegistry } from '@/shell/scenario/registry'
import { EMPTY_VIEW_DESCRIPTOR } from '@/contracts'
import { bindSessionAgent } from '@/stores/session-agent-binding'
import type { ChatSession, AgentConfig } from '@/types'

const SCN_AGENT = 'scn-agent-1' // agents.name（场景实例内部名）

const { updateSessionTitle, listSessions, searchMessages, listActiveStreams, getSessionBranches } = vi.hoisted(() => ({
  updateSessionTitle: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0, query: '' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  getSessionBranches: vi.fn().mockResolvedValue({ branches: [], total: 0 }),
}))

vi.mock('@/api/chat', () => ({
  updateSessionTitle,
  listSessions,
  searchMessages,
  listActiveStreams,
  getSessionBranches,
}))

vi.mock('@/api/desktop', () => ({ setClipboard: vi.fn().mockResolvedValue(undefined) }))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function scenarioSession(extra?: Partial<ChatSession>): ChatSession {
  return {
    id: 's-scn',
    title: SCN_AGENT, // 深链建会话的原始形态：标题=agent 内部名
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
    message_count: 3,
    ...extra,
  }
}

function normalSession(): ChatSession {
  return {
    id: 's-normal',
    title: '普通会话',
    created_at: '2026-04-02T10:00:00Z',
    updated_at: '2026-04-02T10:00:00Z',
    message_count: 1,
  }
}

function mountList(sessions: ChatSession[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chatStore = useChatStore()
  chatStore.sessions = sessions
  chatStore.currentSessionId = 's-normal'
  chatStore.selectSession = vi.fn()
  chatStore.deleteSession = vi.fn().mockResolvedValue(undefined)

  const agentsStore = useAgentsStore()
  agentsStore.registeredAgents = [
    {
      name: SCN_AGENT,
      display_name: '小明的辅导老师',
      model: 'm', provider: 'p',
      metadata: { scenario: 'mock-scn', avatar: '🎓' },
    } as AgentConfig,
  ]

  const wrapper = mount(SessionList, {
    global: {
      plugins: [pinia, createTestI18n()],
      stubs: { ContextMenu: { template: '<div class="context-menu-stub" />' } },
    },
  })
  return wrapper
}

describe('审计单-Medium-4：场景会话自动置顶必须覆盖 localStorage 绑定路径（agent_name=null）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    // 注册领域无关的 mock 场景解析器（registry 通用缝，零 K12 词）
    scenarioRegistry.reset()
    scenarioRegistry.registerResolver((ctx) =>
      ctx.metadata?.scenario === 'mock-scn'
        ? { ...EMPTY_VIEW_DESCRIPTOR, headerTabs: [{ id: 't1', labelKey: 'x', kind: 'chat' }] }
        : null,
    )
  })

  afterEach(() => {
    scenarioRegistry.reset()
  })

  it('对照：后端带 agent_name 的场景会话 → 进「已置顶」分区（置顶机制本身工作）', () => {
    const wrapper = mountList([normalSession(), scenarioSession({ agent_name: SCN_AGENT })])
    expect(wrapper.text(), '带 agent_name 的场景会话应有已置顶分区').toContain('已置顶')
  })

  it('★绑定路径：agent_name=null 但 localStorage 已绑定场景 agent 的会话 → 也必须进「已置顶」分区', () => {
    bindSessionAgent('s-scn', SCN_AGENT)
    const wrapper = mountList([normalSession(), scenarioSession()])
    expect(
      wrapper.text(),
      'localStorage 绑定恢复的场景会话应同样常驻置顶（isScenarioSession 只认 s.agent_name 即漏掉此路径）',
    ).toContain('已置顶')
  })

  it('★标题兜底路径：agent_name=null、无绑定、标题=agent 内部名 → 也应识别为场景会话置顶', () => {
    const wrapper = mountList([normalSession(), scenarioSession()])
    expect(
      wrapper.text(),
      '标题即内部名的老会话（boundAgentOf 设计中的第三路）也应置顶',
    ).toContain('已置顶')
  })
})
