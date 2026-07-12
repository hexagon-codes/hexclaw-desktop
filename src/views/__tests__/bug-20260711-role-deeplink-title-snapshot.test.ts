/**
 * BUG-20260711（治本）：`/chat?role=` 深链建会话时标题必须快照可读 display_name，
 * 绝不落 agent 内部名——标题落库后是会话自己的资产，智能体删除后列表不得回退成
 * `k12-tutor-2O99CPr_` 这类内部 ID（原型 app.html .cs-item 标准：🎓 小明的辅导助手 · 五年级）。
 *
 * 修复点：
 * 1. ChatView 汇点兜底——调用方漏传 roleTitle 时按已加载 agents 解析 display_name；
 * 2. 存量旧会话（修复前标题 = 内部名）深链进入时仍能复用，不重复建会话。
 *
 * 挂载脚手架复用 bug-20260709-session-binding-cleared-on-mount.test.ts（已验证的最小集）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { createSession } from '@/api/chat'

const K12_AGENT = 'k12-tutor-KKE5v8zQ'
const K12_DISPLAY = '小明的辅导老师'

const { mockGetOllamaStatus, mockListSessions } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
  mockListSessions: vi.fn(),
}))

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {} as Record<string, string>, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
  sendChat: vi.fn(),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  appendSessionMessagesBatch: vi.fn().mockResolvedValue({}),
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  listSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  appendSessionMessage: vi.fn().mockResolvedValue({}),
  createSession: vi.fn().mockResolvedValue({}),
  updateSessionTitle: vi.fn().mockResolvedValue({}),
  suggestSessionTitle: vi.fn().mockResolvedValue({}),
  deleteSession: vi.fn().mockResolvedValue({}),
  deleteMessage: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: vi.fn().mockReturnValue(false),
    connect: vi.fn().mockRejectedValue(new Error('test')),
    clearCallbacks: vi.fn(), clearStreamCallbacks: vi.fn(),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onReply: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onApprovalRequest: vi.fn().mockReturnValue(() => {}),
    onMemorySaved: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn(),
    sendRaw: vi.fn(),
    triggerError: vi.fn(),
    sendApprovalResponse: vi.fn(),
  },
}))

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
  getAgents: vi.fn().mockResolvedValue({
    agents: [
      {
        name: 'k12-tutor-KKE5v8zQ',
        display_name: '小明的辅导老师',
        model: 'qwen3.5:9b',
        provider: 'ollama',
        metadata: { scenario: 'k12', 'k12.grade_term': '五年级上' },
      },
    ],
    default: '',
  }),
  createRole: vi.fn(), updateRole: vi.fn(), deleteRole: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  searchKnowledge: vi.fn().mockResolvedValue({ result: [] }),
  getDocuments: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
  addDocument: vi.fn(), deleteDocument: vi.fn(), reindexDocument: vi.fn(), uploadDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn().mockReturnValue(false),
  isKnowledgeUploadUnsupportedFormat: vi.fn().mockReturnValue(false),
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: 'p-default', providers: {},
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  updateLLMConfig: vi.fn(),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/desktop', () => ({ setClipboard: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() { return null }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

vi.mock('markdown-it', () => ({
  default: vi.fn().mockImplementation(() => ({
    render: (s: string) => `<p>${s}</p>`,
    renderer: { rules: { fence: null } },
    utils: { escapeHtml: (s: string) => s },
  })),
}))

vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => mockRoute),
  useRouter: vi.fn(() => ({ push: mockRouterPush, replace: mockRouterReplace })),
}))

function buildConfig() {
  return {
    llm: {
      defaultModel: 'model-default',
      defaultProviderId: 'p-default',
      providers: [
        {
          id: 'p-default', name: '默认厂商', type: 'openai', backendKey: 'defaultprov',
          enabled: true, apiKey: 'k', baseUrl: '',
          models: [{ id: 'model-default', name: 'Default Model' }],
          selectedModelId: 'model-default',
        },
      ],
    },
    security: {
      gateway_enabled: true, injection_detection: true, pii_filter: false,
      content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60,
    },
    general: {
      language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false,
      defaultAgentRole: '',
    },
    notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
    mcp: { default_protocol: 'stdio' },
  }
}

function createTestI18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountChatView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const settingsStore = useSettingsStore()
  settingsStore.config = buildConfig() as unknown as typeof settingsStore.config
  const i18n = createTestI18n()
  return mount(ChatView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        SessionList: { template: '<div data-testid="session-list" />' },
        MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        MessageActions: { template: '<div />' },
        ChatSearchDialog: { template: '<div />' },
        ChatExportMenu: { template: '<div />' },
        ResearchProgress: { template: '<div />' },
        ArtifactsPanel: { template: '<div />' },
        ContextMenu: { template: '<div />' },
      },
    },
  })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  })
})

describe('BUG-20260711：role 深链会话标题快照 display_name（治本）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    mockRoute.query = { role: K12_AGENT } // 关键：不带 roleTitle（K12AgentCard 修复前的调用形态）
    mockRoute.path = '/chat'
    mockRoute.params = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★漏传 roleTitle 时新会话标题 = display_name（汇点兜底），绝不落 agent 内部名', async () => {
    mockListSessions.mockResolvedValue({ sessions: [], total: 0 })
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()

    expect(chatStore.currentSessionId, '前置：深链应已建会话').toBeTruthy()
    // 核心断言：createSession 落库标题 = 可读显示名（agent 删除后列表仍是「小明的辅导老师」）
    const calls = (createSession as unknown as Mock).mock.calls
    expect(calls.length, '前置：走了新建会话').toBeGreaterThan(0)
    const firstCall = calls[0]
    if (!firstCall) throw new Error('前置：createSession 首次调用缺失')
    expect(firstCall[1]).toBe(K12_DISPLAY)
    expect(firstCall[1]).not.toBe(K12_AGENT)
  })

  it('存量旧会话（标题 = 内部名）深链进入时复用，不重复建会话', async () => {
    mockListSessions.mockResolvedValue({
      sessions: [
        {
          id: 's-legacy',
          title: K12_AGENT, // 修复前落库的内部名标题
          created_at: '2026-07-01T10:00:00Z',
          updated_at: '2026-07-10T10:00:00Z',
          message_count: 27,
        },
      ],
      total: 1,
    })
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()

    expect(chatStore.currentSessionId, '应复用存量内部名标题会话').toBe('s-legacy')
    expect((createSession as unknown as Mock).mock.calls.length, '不得重复建会话').toBe(0)
  })
})
