/**
 * BUG-20260710：孤儿会话绑定——localStorage 绑定指向【已删除】的 agent 时，
 * 前端仍以该绑定恢复 agentRole（场景皮肤/标题照常渲染），后端 role 查无此人
 * 回落默认助理小蟹 → 双端呈现撕裂（真机取证：冒烟gc6x 孤儿会话里小蟹自我介绍）。
 *
 * 期望行为（本测试断言，未修复时 FAIL 即证明 bug）：agents 列表加载完成后，
 * 若绑定的 agent 不在列表（且非 @im/ 频道默认 agent）→ 清 agentRole + 清绑定，
 * 会话回归普通展示（诚实降级），配合后端 fail-loud guard（engine bug_20260710_ghost_agent_role_test）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { bindSessionAgent, getSessionAgent } from '@/stores/session-agent-binding'

const GHOST_AGENT = 'k12-tutor-DELETED00' // 已删除
const ORPHAN_SESSION = 's-orphan'

const { mockGetOllamaStatus, mockGetAgents } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
  mockGetAgents: vi.fn(),
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
        id: 's-orphan',
        title: '冒烟gc6x的辅导老师 · 六年级',
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
  getAgents: mockGetAgents,
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

describe('BUG-20260710：孤儿绑定（agent 已删除）必须被探测并诚实降级', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    localStorage.setItem('hexclaw_lastSessionId', ORPHAN_SESSION)
    bindSessionAgent(ORPHAN_SESSION, GHOST_AGENT) // 绑定指向已删除的 agent
    mockRoute.query = {}
    mockRoute.path = '/chat'
    mockRoute.params = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
    mockGetAgents.mockReset().mockResolvedValue({
      agents: [
        {
          name: 'k12-tutor-EXISTS01',
          display_name: '冒烟lboe的辅导助手',
          model: 'qwen3.5:9b',
          provider: 'ollama',
          metadata: { scenario: 'k12', 'k12.grade_term': '五年级上' },
        },
      ],
      default: '',
    })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★agents 加载完成后：孤儿绑定被清、agentRole 复位（不再冒充场景人设）', async () => {
    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()

    expect(chatStore.currentSessionId, '前置：lastSessionId 自动选中孤儿会话').toBe(ORPHAN_SESSION)
    // 核心断言①：agentRole 不得停留在已删除的 agent（否则发消息后端回落小蟹/报错，前端却渲染辅导皮肤）
    expect(
      chatStore.agentRole,
      'agents 已加载且查无此 agent → agentRole 应清空（诚实降级为普通会话）',
    ).toBe('')
    // 核心断言②：孤儿绑定从 localStorage 清除，防止下次选中再次复活（清除后实现返回空串/null 均可）
    expect(getSessionAgent(ORPHAN_SESSION), '孤儿绑定应被清除').toBeFalsy()
  })

  it('首次加载未完成时保留绑定，成功返回空列表后才清理最后一个 Agent 的孤儿绑定', async () => {
    let resolveAgents!: (value: { agents: []; default: string }) => void
    mockGetAgents.mockReturnValueOnce(new Promise((resolve) => {
      resolveAgents = resolve
    }))

    mountChatView()
    await vi.waitFor(() => expect(mockGetAgents).toHaveBeenCalledOnce())
    const chatStore = useChatStore()

    expect(chatStore.agentRole, 'agents 尚未加载完成，不得把空初值误判为已删除').toBe(GHOST_AGENT)
    expect(getSessionAgent(ORPHAN_SESSION), 'agents 尚未加载完成，绑定必须保留').toBe(GHOST_AGENT)

    resolveAgents({ agents: [], default: '' })
    await flushPromises()

    expect(chatStore.agentRole, 'agents 成功加载为空，说明最后一个 Agent 已删除').toBe('')
    expect(getSessionAgent(ORPHAN_SESSION), '已确认空集合后应清理孤儿绑定').toBeFalsy()
  })

  it('已加载集合被同数量的新 Agent 替换时也清理孤儿绑定', async () => {
    mockGetAgents.mockReset()
      .mockResolvedValueOnce({
        agents: [{ name: GHOST_AGENT, display_name: '旧智能体', model: '', provider: '' }],
        default: '',
      })
      .mockResolvedValueOnce({
        agents: [{ name: 'replacement-agent', display_name: '新智能体', model: '', provider: '' }],
        default: '',
      })

    mountChatView()
    await flushPromises()
    const chatStore = useChatStore()
    const agentsStore = useAgentsStore()

    expect(chatStore.agentRole, '首次列表仍含绑定 Agent，不应清理').toBe(GHOST_AGENT)
    await agentsStore.loadAgents()
    await flushPromises()

    expect(chatStore.agentRole, '名称集合已替换，即使长度不变也应重新判定孤儿').toBe('')
    expect(getSessionAgent(ORPHAN_SESSION), '同数量替换后旧绑定应清理').toBeFalsy()
  })

  it('对照：@im/ 频道默认 agent 不在可见列表属正常，不得误清', async () => {
    localStorage.clear()
    localStorage.setItem('hexclaw_lastSessionId', ORPHAN_SESSION)
    bindSessionAgent(ORPHAN_SESSION, '@im/feishu:demo') // 频道默认 agent：registeredAgents 恒不含
    mountChatView()
    await flushPromises()
    expect(getSessionAgent(ORPHAN_SESSION), '@im/ 绑定不得被孤儿守卫误清').toBe('@im/feishu:demo')
  })
})
