/**
 * BUG-20260626-2 回归测试：切到别的页面再返回会话 → 之前绑定的模型被「设置的默认模型」覆盖。
 *
 * 用户反馈（精确定位）：
 *   - 在会话界面「切换会话」选择的模型是正确的（BUG-20260625 已修，会话间隔离 OK）。
 *   - 但「切到别的页面（设置/记忆/知识库…）再切回会话」时，模型选择变成了【设置的默认模型】，
 *     即之前为该会话绑定的模型被默认模型覆盖掉了。
 *
 * 根因：ChatView 在 App.vue 里以 `:key="route.path"` 渲染、**无 keep-alive** —— 离开 /chat 再返回
 *   会**完整重挂载**，onMounted 重跑。chatStore（Pinia 单例，含 currentSessionId）跨视图存活，
 *   但 onMounted 里 `loadLLMConfig()` 无条件把 selectedModel 落成全局默认，而当前会话的绑定恢复
 *   只能靠 `availableModels` watcher 偶发触发（列表无异步变化时根本不触发）→ 绑定被默认静默覆盖。
 *
 * 不变量（模型优先级）：会话绑定 > Agent > 全局默认。重挂载（返回会话）必须按此优先级**确定性**恢复，
 *   不得依赖 watcher 偶发触发，更不得被默认模型覆盖。
 *
 * 复现手法：在「同一个 pinia」上 mount → 进入并绑定会话 A 的模型 → unmount（模拟离开 /chat 去别的功能）
 *   → 在同一 pinia 上 remount（模拟返回 /chat，currentSessionId 仍为 A）。
 *   关键：mock `listSessions` 返回含 'A' 的列表，使 loadSessions→pruneSessionModels 不会把 A 的绑定剪掉
 *   —— 隔离出「重挂载未恢复」这唯一变量（真实环境会话 A 存在，绑定不会被剪）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { setSessionModel, getSessionModel } from '@/stores/session-model-binding'

const { mockGetOllamaStatus } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
}))

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {}, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

// ─── Mock API ───
// ★关键：listSessions 返回含 'A' 的会话列表 → loadSessions→pruneSessionModels 保留 A 的绑定。
vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 'A' }),
  sendChat: vi.fn(),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  appendSessionMessagesBatch: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({
    sessions: [
      { id: 'A', title: '会话 A', created_at: '2026-06-26T00:00:00Z', updated_at: '2026-06-26T00:00:00Z', message_count: 2 },
    ],
  }),
  listSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
  createSession: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  suggestSessionTitle: vi.fn().mockResolvedValue({}),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  appendSessionMessage: vi.fn().mockResolvedValue(undefined),
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
  getAgents: vi.fn().mockResolvedValue({ agents: [] }),
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

// ─── 模型配置：全局默认 model-default vs 会话覆盖 model-override ───
const DEFAULT_MODEL = 'model-default'
const OVERRIDE_MODEL = 'model-override'

function buildConfig() {
  return {
    llm: {
      defaultModel: DEFAULT_MODEL,
      defaultProviderId: 'p-default',
      providers: [
        {
          id: 'p-default', name: '默认厂商', type: 'openai', backendKey: 'defaultprov',
          enabled: true, apiKey: 'k', baseUrl: '',
          models: [{ id: DEFAULT_MODEL, name: 'Default Model' }],
          selectedModelId: DEFAULT_MODEL,
        },
        {
          id: 'p-other', name: '其他厂商', type: 'openai', backendKey: 'otherprov',
          enabled: true, apiKey: 'k', baseUrl: '',
          models: [{ id: OVERRIDE_MODEL, name: 'Override Model' }],
          selectedModelId: OVERRIDE_MODEL,
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

/** 在「指定 pinia」上挂载 ChatView —— 共享 pinia 才能模拟「组件重挂载、store 存活」的路由往返。 */
function mountChatView(pinia: Pinia) {
  setActivePinia(pinia)
  const settingsStore = useSettingsStore()
  if (!settingsStore.config) {
    settingsStore.config = buildConfig() as unknown as typeof settingsStore.config
  }
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
        ArtifactsPanel: { template: '<div />' },
        ContextMenu: { template: '<div />' },
      },
    },
  })
}

interface ChatViewVM {
  selectedModel: string
  userOverrodeModel: boolean
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

describe('BUG-20260626-2 切到别的页面再返回会话：绑定模型被默认覆盖（路由往返重挂载）', () => {
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
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★核心：在会话 A 绑定 OVERRIDE，离开 ChatView（unmount）再返回（remount，chatStore 存活）→ 仍是 OVERRIDE，不被默认覆盖', async () => {
    const pinia = createPinia()

    // ① 第一次进入 ChatView，进入会话 A 并把它的模型绑定为 OVERRIDE_MODEL
    const w1 = mountChatView(pinia)
    await flushPromises()
    const chatStore = useChatStore()
    setSessionModel('A', { model: OVERRIDE_MODEL, providerId: 'p-other', providerKey: 'otherprov', providerName: '其他厂商' })
    chatStore.currentSessionId = 'A'
    await flushPromises()
    expect((w1.vm as unknown as ChatViewVM).selectedModel, '进入会话 A 应恢复其绑定模型').toBe(OVERRIDE_MODEL)
    expect(getSessionModel('A')?.model).toBe(OVERRIDE_MODEL)

    // ② 离开 ChatView 去「别的页面/功能」：组件 unmount（chatStore + localStorage 绑定存活）
    w1.unmount()

    // ③ 返回 ChatView：在同一 pinia 上重新挂载（currentSessionId 仍为 'A'，绑定仍在）
    const w2 = mountChatView(pinia)
    await flushPromises()

    // 绑定仍在（listSessions 含 A → prune 未剪掉），且模型必须被恢复为 OVERRIDE，不被默认覆盖
    expect(getSessionModel('A')?.model, '会话 A 仍存在 → 绑定不应被 prune 剪掉').toBe(OVERRIDE_MODEL)
    expect((w2.vm as unknown as ChatViewVM).selectedModel, '返回会话后必须恢复绑定模型 OVERRIDE，不得被设置默认模型覆盖').toBe(OVERRIDE_MODEL)
    expect((w2.vm as unknown as ChatViewVM).userOverrodeModel, '有会话绑定 → 视为用户覆盖，优先于默认').toBe(true)
  })

  it('回归保护：无绑定会话往返返回 → 仍回退全局默认（不凭空带模型，优先级正路不被误伤）', async () => {
    const pinia = createPinia()

    const w1 = mountChatView(pinia)
    await flushPromises()
    const chatStore = useChatStore()
    chatStore.currentSessionId = 'A' // A 无任何模型绑定
    await flushPromises()
    expect((w1.vm as unknown as ChatViewVM).selectedModel).toBe(DEFAULT_MODEL)

    w1.unmount()

    const w2 = mountChatView(pinia)
    await flushPromises()
    expect((w2.vm as unknown as ChatViewVM).selectedModel, '无绑定会话返回仍是全局默认').toBe(DEFAULT_MODEL)
    expect(getSessionModel('A'), '无绑定会话不得被凭空写入绑定').toBeNull()
  })
})
