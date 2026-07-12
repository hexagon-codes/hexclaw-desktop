/**
 * BUG-20260712-K（复现→修复→锁定）：装了含自愈的新包重开 app，左侧栏仍显示内部 ID。
 *
 * 根因：存量标题自愈在 ChatView onMounted **一次性**触发——冷启动时 sidecar 引擎尚未就绪，
 * loadSessions/loadAgents 拿到空数据，自愈对空列表跑了一轮就永不再跑；引擎随后就绪、
 * 列表补上了，但自愈时机已过（孤儿文案层同理依赖 agentsLoaded）。
 *
 * 根修：触发从「挂载时序驱动」改「数据就绪驱动」——watch([sessions.length, agentsLoaded])，
 * 两者齐备才跑；自愈幂等（愈后不再命中），多次触发零副作用。
 * 本测试模拟冷启动：挂载时后端全挂 → 稍后数据就绪 → 自愈必须补跑。未修复代码 FAIL。
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
import type { ChatSession } from '@/types'

const AGENT = 'k12-tutor-6GXQsQ7m'
const DISPLAY = '小王的辅导助手 · 五年级'

const { mockGetOllamaStatus, mockListSessions, mockGetAgents, mockUpdateSessionTitle } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
  mockListSessions: vi.fn(),
  mockGetAgents: vi.fn(),
  mockUpdateSessionTitle: vi.fn().mockResolvedValue({}),
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
  updateSessionTitle: (...args: unknown[]) => mockUpdateSessionTitle(...args),
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
    sendMessage: vi.fn(), sendRaw: vi.fn(), triggerError: vi.fn(), sendApprovalResponse: vi.fn(),
  },
}))

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
  getAgents: (...args: unknown[]) => mockGetAgents(...args),
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
      defaultModel: 'model-default', defaultProviderId: 'p-default',
      providers: [{
        id: 'p-default', name: '默认厂商', type: 'openai', backendKey: 'defaultprov',
        enabled: true, apiKey: 'k', baseUrl: '',
        models: [{ id: 'model-default', name: 'Default Model' }], selectedModelId: 'model-default',
      }],
    },
    security: { gateway_enabled: true, injection_detection: true, pii_filter: false, content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60 },
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

describe('BUG-20260712-K：自愈必须数据就绪驱动（冷启动 sidecar 未就绪不空跑）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    mockRoute.query = {}
    mockRoute.path = '/chat'
    mockRoute.params = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
    mockUpdateSessionTitle.mockResolvedValue({})
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★冷启动：挂载时后端全挂（空数据）→ 引擎稍后就绪补上数据 → 自愈必须补跑', async () => {
    // 挂载瞬间：引擎未就绪，sessions/agents 全空（真机冷启动形态）
    mockListSessions.mockRejectedValue(new Error('engine not ready'))
    mockGetAgents.mockRejectedValue(new Error('engine not ready'))
    mountChatView()
    await flushPromises()
    expect(mockUpdateSessionTitle, '前置：空数据阶段不该有任何自愈 PATCH').not.toHaveBeenCalled()

    // 引擎就绪：数据补上（等价 sidecar-ready 后重拉）
    const chatStore = useChatStore()
    const agentsStore = useAgentsStore()
    chatStore.sessions = [
      { id: 's-legacy', title: AGENT, created_at: '2026-07-10T10:00:00Z', updated_at: '2026-07-10T10:00:00Z', message_count: 2 } as ChatSession,
    ]
    agentsStore.registeredAgents = [{ name: AGENT, display_name: DISPLAY, metadata: {} }] as never
    agentsStore.agentsLoaded = true
    await flushPromises()

    // 核心断言：数据就绪后自愈补跑（一次性挂载触发=永不生效，左侧栏永远显示内部 ID）
    expect(mockUpdateSessionTitle).toHaveBeenCalledWith('s-legacy', DISPLAY)
    expect(chatStore.sessions[0]!.title).toBe(DISPLAY)
  })

  it('幂等护栏：数据多次变化（列表刷新）不重复 PATCH 已愈会话', async () => {
    mockListSessions.mockResolvedValue({ sessions: [], total: 0 })
    mockGetAgents.mockResolvedValue({ agents: [{ name: AGENT, display_name: DISPLAY, metadata: {} }], default: '' })
    mountChatView()
    await flushPromises()

    const chatStore = useChatStore()
    const agentsStore = useAgentsStore()
    agentsStore.agentsLoaded = true
    chatStore.sessions = [
      { id: 's-legacy', title: AGENT, created_at: '2026-07-10T10:00:00Z', updated_at: '2026-07-10T10:00:00Z', message_count: 2 } as ChatSession,
    ]
    await flushPromises()
    expect(mockUpdateSessionTitle).toHaveBeenCalledTimes(1)

    // 列表再次刷新（愈后标题已是显示名）→ 不再 PATCH
    chatStore.sessions = [...chatStore.sessions, { id: 's-new', title: '普通会话', created_at: '2026-07-12T10:00:00Z', updated_at: '2026-07-12T10:00:00Z', message_count: 1 } as ChatSession]
    await flushPromises()
    expect(mockUpdateSessionTitle).toHaveBeenCalledTimes(1)
  })
})
