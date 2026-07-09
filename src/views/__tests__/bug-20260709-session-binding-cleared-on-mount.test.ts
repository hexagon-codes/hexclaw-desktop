/**
 * 审计单验证（20260709 · High）：普通进入 /chat（无 ?role= 深链）挂载时，
 * loadSessions→selectSession 已按 session-agent-binding 恢复的 agentRole
 * 被 onMounted 末尾的 `if (!roleQuery) chatStore.agentRole = ''` 无条件清空。
 *
 * 影响链：应用重载/切回聊天页 → 选中既有 K12 会话 → 绑定恢复辅导老师 agent →
 * 无 role query 清空 → scenarioCtx 变 null → K12 增强 UI 消失、消息回落默认助理。
 * 且清空后标题兜底 watcher 因「已有绑定」early return，无法再救回（永久丢失）。
 *
 * 断言的是**正确行为**（绑定会话不带 role query 挂载后 agentRole 保持）——
 * 测试失败即证明 bug 存在。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { bindSessionAgent, getSessionAgent } from '@/stores/session-agent-binding'

const K12_AGENT = 'k12-tutor-KKE5v8zQ'
const K12_SESSION = 's-k12'

const { mockGetOllamaStatus } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
}))

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {} as Record<string, string>, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

// ─── Mock API（复用 ChatView.test.ts 验证过的最小挂载脚手架；补 listSessions/listSessionMessages
//     让 loadSessions 能返回既有 K12 会话并触发 lastSessionId 自动选中） ───
vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
  sendChat: vi.fn(),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  appendSessionMessagesBatch: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({
    sessions: [
      {
        id: 's-k12',
        title: 'k12-tutor-KKE5v8zQ',
        created_at: '2026-07-01T10:00:00Z',
        updated_at: '2026-07-08T10:00:00Z',
        message_count: 4,
      },
    ],
    total: 1,
  }),
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

describe('审计单-High-1：绑定会话在普通挂载（无 ?role=）后不得丢失 agentRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    // 预置：上次会话即 K12 会话，且已有 session→agent 绑定（BUG-20260708 修复写入的）
    localStorage.setItem('hexclaw_lastSessionId', K12_SESSION)
    bindSessionAgent(K12_SESSION, K12_AGENT)
    mockRoute.query = {}
    mockRoute.path = '/chat'
    mockRoute.params = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★挂载完成后 agentRole 应保持绑定恢复值（= 辅导老师），不得被无 role query 清空', async () => {
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()

    // loadSessions→getLastSessionId→selectSession 应已自动选中 K12 会话
    expect(chatStore.currentSessionId, '前置：lastSessionId 自动选中 K12 会话').toBe(K12_SESSION)
    // 绑定仍在 localStorage（未被 prune）
    expect(getSessionAgent(K12_SESSION), '前置：session→agent 绑定存在').toBe(K12_AGENT)

    // 核心断言：绑定恢复的 agentRole 不得被 onMounted 末尾 `if (!roleQuery) agentRole=''` 清空
    expect(
      chatStore.agentRole,
      '绑定会话普通挂载后 agentRole 必须保持（清空即 K12 场景增强消失、消息落回默认助理）',
    ).toBe(K12_AGENT)
    expect(chatStore.chatMode, '绑定会话应保持 agent 模式').toBe('agent')
  })

  it('对照：selectSession 本身能正确恢复绑定（证明丢失点在挂载清空，而非绑定恢复层）', async () => {
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()

    // 手动再走一次 selectSession（等价用户点击会话列表）→ 恢复正常
    await chatStore.selectSession(K12_SESSION)
    await flushPromises()
    expect(chatStore.agentRole).toBe(K12_AGENT)
    expect(chatStore.chatMode).toBe('agent')
  })
})
