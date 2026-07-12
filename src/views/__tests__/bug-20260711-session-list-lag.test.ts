/**
 * BUG-20260711-G（复现→修复→锁定）：点智能体（翻译官）进入会话后，会话列表不显示该会话，
 * 直到发消息收到回复列表才出现。
 *
 * 期望行为：`/chat?role=…` 深链挂载完成后，新会话立即出现在 chatStore.sessions
 * （SessionList 直接渲染该数组），标题=显示名——不等首条回复。
 * 本测试在未修复代码上若 FAIL 即钉死丢失点；修复后 PASS 永久回归锁。
 *
 * 脚手架复用 bug-20260709-session-binding-cleared-on-mount.test.ts（已验证的最小集）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'

const AGENT = 'translator-abc'
const DISPLAY = '翻译官'

const { mockGetOllamaStatus, mockListSessions, mockCreateSession } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
  mockListSessions: vi.fn(),
  mockCreateSession: vi.fn().mockResolvedValue({}),
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
  createSession: (...args: unknown[]) => mockCreateSession(...args),
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
    agents: [{ name: 'translator-abc', display_name: '翻译官', model: '', provider: '', metadata: {} }],
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

vi.mock('@/api/ollama', () => ({ getOllamaStatus: () => mockGetOllamaStatus() }))

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
    general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
    notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
    mcp: { default_protocol: 'stdio' },
  }
}

function mountChatView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const settingsStore = useSettingsStore()
  settingsStore.config = buildConfig() as unknown as typeof settingsStore.config
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
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

describe('BUG-20260711-G：深链进入 agent 会话后列表必须立即含该会话（不等首条回复）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    mockRoute.query = { role: AGENT, roleTitle: DISPLAY }
    mockRoute.path = '/chat'
    mockRoute.params = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
    mockCreateSession.mockResolvedValue({})
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★空列表 + 深链进入 → 挂载完成后 sessions 立即含「翻译官」会话', async () => {
    // 后端行为对齐真机取证：list 稳定返回「创建前」快照为空；新会话靠本地 upsert 立即上屏
    mockListSessions.mockResolvedValue({ sessions: [], total: 0 })
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()

    expect(chatStore.currentSessionId, '前置：深链已建会话').toBeTruthy()
    const found = chatStore.sessions.find((s) => s.id === chatStore.currentSessionId)
    expect(found, '会话列表必须立即含新会话（不等首条回复）').toBeTruthy()
    expect(found!.title).toBe(DISPLAY)
  })

  it('★后端 list 響應慢于建会话（竞态）：晚到的空列表不得把刚建的会话从列表冲掉', async () => {
    // 模拟：createSession 已成功，但 loadSessions 的响应仍是创建前的空快照（后端读写窗口）
    let resolveList!: (v: { sessions: unknown[]; total: number }) => void
    mockListSessions
      .mockResolvedValueOnce({ sessions: [], total: 0 }) // 挂载初次 loadSessions
      .mockImplementationOnce(() => new Promise((r) => { resolveList = r })) // 深链后的刷新（挂起）
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()
    const sid = chatStore.currentSessionId
    expect(sid).toBeTruthy()

    resolveList({ sessions: [], total: 0 }) // 晚到的旧快照
    await flushPromises()
    expect(
      chatStore.sessions.find((s) => s.id === sid),
      '晚到的旧列表快照不得冲掉当前会话条目',
    ).toBeTruthy()
  })
})
