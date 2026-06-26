/**
 * BUG-20260625 回归测试：切换会话后「会话模型被错误改变」（跨会话串模型）。
 *
 * 用户反馈：切换会话之后，会话模型会变（本地难复现、几率低）。
 *
 * 模型选择三处逻辑：
 *   1) 设置 → LLM 供应商默认模型（全局默认，新会话跟随）
 *   2) 智能体绑定模型（用该 Agent 打开的会话跟随）
 *   3) 会话级覆盖（会话里选了别的模型 → 绑定到该会话，保证上下文一致）
 *
 * 本测试在 ChatView 真实组件上驱动 `currentSessionId` 切换，钉死编排层不变量：
 *   - BUG B（主路径，可复现）：在「有会话级绑定」的会话 A 选了模型 X，切到「无绑定」会话 B 后，
 *     B 必须回退到【全局默认模型】，不得沿用 A 的模型 X。
 *   - BUG A（跨会话污染，低复现）：删除当前会话 A（currentSessionId→null）后再选中无绑定会话 B，
 *     B 不得被偷偷写入 A 的模型绑定（残留的手动覆盖标记不得串到 B）。
 *   - 回归保护：无绑定的新会话「首发前先选模型」→ 创建后仍正确补绑（不被修复误伤）。
 *
 * 既有 audit-session-model-binding-20260623 只覆盖了 localStorage 持久化基元，
 * 未覆盖 ChatView.applySessionModel 的切换编排——本 bug 正落在这个漏测缺口里。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import {
  setSessionModel,
  getSessionModel,
} from '@/stores/session-model-binding'

const { mockGetOllamaStatus } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
}))

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {}, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

// ─── Mock API（复用 ChatView.test.ts 验证过的最小挂载脚手架） ───
vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
  sendChat: vi.fn(),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  appendSessionMessagesBatch: vi.fn().mockResolvedValue({}),
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

// ─── 测试用模型配置：全局默认 model-default vs 会话覆盖 model-override ───
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

interface ChatViewVM {
  selectedModel: string
  userOverrodeModel: boolean
  selectModel: (modelId: string, providerId?: string, providerKey?: string, providerName?: string) => void
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

describe('BUG-20260625 切换会话后会话模型被错误改变（跨会话串模型）', () => {
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

  it('挂载后初始跟随全局默认模型（基线）', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const vm = wrapper.vm as unknown as ChatViewVM
    expect(vm.selectedModel).toBe(DEFAULT_MODEL)
    expect(vm.userOverrodeModel).toBe(false)
  })

  it('★BUG B：从「绑定 X 的会话 A」切到「无绑定会话 B」→ B 必须回退全局默认，不沿用 A 的模型', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const vm = wrapper.vm as unknown as ChatViewVM
    const chatStore = useChatStore()

    // 会话 A 显式绑定 OVERRIDE_MODEL（在 onMounted→loadSessions→pruneSessionModels 之后种，
    // 避免空会话列表把预埋绑定剪掉——真实环境会话非空不触发）。
    setSessionModel('A', { model: OVERRIDE_MODEL, providerId: 'p-other', providerKey: 'otherprov', providerName: '其他厂商' })

    // 进入 A：恢复其绑定模型（这是「会话级覆盖」的正确行为）
    chatStore.currentSessionId = 'A'
    await flushPromises()
    expect(vm.selectedModel, 'A 应恢复其会话绑定模型').toBe(OVERRIDE_MODEL)
    expect(vm.userOverrodeModel).toBe(true)

    // 切到无绑定会话 B：必须回退全局默认（修复前会残留显示 A 的 OVERRIDE_MODEL）
    chatStore.currentSessionId = 'B'
    await flushPromises()
    expect(vm.selectedModel, 'B 无绑定 → 必须回退全局默认，不得沿用 A 的模型').toBe(DEFAULT_MODEL)
  })

  it('★BUG A：删除当前会话(→null)后选中无绑定会话 B → B 不得被偷偷写入 A 的模型绑定', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const vm = wrapper.vm as unknown as ChatViewVM
    const chatStore = useChatStore()

    setSessionModel('A', { model: OVERRIDE_MODEL, providerId: 'p-other', providerKey: 'otherprov', providerName: '其他厂商' })

    // 进入 A → 恢复绑定（此时 userOverrodeModel=true，selectedModel=OVERRIDE_MODEL）
    chatStore.currentSessionId = 'A'
    await flushPromises()
    expect(vm.selectedModel).toBe(OVERRIDE_MODEL)

    // 删除当前会话：deleteSession 把 currentSessionId 置 null
    chatStore.currentSessionId = null
    await flushPromises()

    // 选中一个从未自定义过模型的已有会话 B（null → B）
    chatStore.currentSessionId = 'B'
    await flushPromises()

    // B 不得被写入任何绑定（残留的手动覆盖不得串到 B）
    expect(getSessionModel('B'), 'B 是无绑定会话，切换不得为其凭空创建模型绑定').toBeNull()
    expect(vm.selectedModel, 'B 应显示全局默认模型').toBe(DEFAULT_MODEL)
  })

  it('回归保护：无绑定新会话「首发前先选模型」→ 创建后仍正确补绑到新会话', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const vm = wrapper.vm as unknown as ChatViewVM
    const chatStore = useChatStore()

    // 新会话（currentSessionId 仍为 null）下用户显式选了 OVERRIDE_MODEL
    vm.selectModel(OVERRIDE_MODEL, 'p-other', 'otherprov', '其他厂商')
    await flushPromises()
    expect(vm.selectedModel).toBe(OVERRIDE_MODEL)
    expect(vm.userOverrodeModel).toBe(true)

    // 发送首条消息 → ensureSession 创建真实会话 id（null → 'C'）
    chatStore.currentSessionId = 'C'
    await flushPromises()

    // 用户首发前选的模型应被固定到新会话 C
    expect(getSessionModel('C')?.model, '新会话首发选的模型应补绑到新会话 id').toBe(OVERRIDE_MODEL)
  })
})
