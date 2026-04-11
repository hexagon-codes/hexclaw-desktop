import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'

const { parseDocument, isDocumentFile } = vi.hoisted(() => ({
  parseDocument: vi.fn(),
  isDocumentFile: vi.fn(),
}))

const { setClipboard } = vi.hoisted(() => ({
  setClipboard: vi.fn().mockResolvedValue(undefined),
}))

const { mockGetOllamaStatus } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
}))

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {}, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

// ─── Mock API 模块 ──────────────────────────────────────
vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: '你好！', session_id: 's1' }),
  sendChat: vi.fn(),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
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

// DB layer removed — all data operations go through services/API

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  searchKnowledge: vi.fn().mockResolvedValue({ result: [] }),
  getDocuments: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  reindexDocument: vi.fn(),
  uploadDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn().mockReturnValue(false),
  isKnowledgeUploadUnsupportedFormat: vi.fn().mockReturnValue(false),
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: 'openai',
    providers: {},
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

vi.mock('@/utils/file-parser', () => ({
  parseDocument,
  isDocumentFile,
}))

vi.mock('@/api/desktop', () => ({
  setClipboard,
}))

// Mock Tauri Store
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() { return null }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

// Mock lucide-vue-next 图标组件（避免渲染问题）
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

// Mock markdown-it（MarkdownRenderer 依赖）
vi.mock('markdown-it', () => ({
  default: vi.fn().mockImplementation(() => ({
    render: (s: string) => `<p>${s}</p>`,
    renderer: { rules: { fence: null } },
    utils: { escapeHtml: (s: string) => s },
  })),
}))

/**
 * 创建测试用 i18n 实例
 */
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

// Mock vue-router
vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => mockRoute),
  useRouter: vi.fn(() => ({ push: mockRouterPush, replace: mockRouterReplace })),
}))

/**
 * 挂载 ChatView 的辅助函数
 */
function mountChatView(options?: { setup?: () => void }) {
  const pinia = createPinia()
  setActivePinia(pinia)
  options?.setup?.()
  const i18n = createTestI18n()

  return mount(ChatView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        // 使用浅渲染替换复杂子组件，保留关键交互组件
        SessionList: { template: '<div data-testid="session-list" />' },
        MarkdownRenderer: {
          props: ['content'],
          template: '<div class="markdown-stub">{{ content }}</div>',
        },
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

// jsdom 不提供 scrollIntoView 和 matchMedia，需要手动补齐
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('ChatView — E2E 关键路径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    isDocumentFile.mockReturnValue(false)
    parseDocument.mockResolvedValue({ text: '', fileName: '', pageCount: 0 })
    mockRoute.query = {}
    mockRoute.path = '/chat'
    mockRoute.params = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  // ────────────────────────────────────────────────────
  // 1. 渲染：输入框和发送按钮
  // ────────────────────────────────────────────────────
  it('renders chat input area with textarea and send button', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    // ChatInput 组件应被渲染（包含 textarea）
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)

    // 发送按钮存在（title="发送 (Enter)"）
    const sendBtn = wrapper.find('button[title="发送 (Enter)"]')
    expect(sendBtn.exists()).toBe(true)
  })

  it('keeps regular chat on Xiaoxie default persona even if an old default role is stored', async () => {
    mountChatView({
      setup: () => {
        const settingsStore = useSettingsStore()
        settingsStore.config = {
          llm: {
            providers: [],
            defaultModel: '',
            defaultProviderId: '',
          },
          security: {
            gateway_enabled: true,
            injection_detection: true,
            pii_filter: false,
            content_filter: true,
            max_tokens_per_request: 8192,
            rate_limit_rpm: 60,
          },
          general: {
            language: 'zh-CN',
            log_level: 'info',
            data_dir: '',
            auto_start: false,
            defaultAgentRole: 'assistant',
          },
          notification: {
            system_enabled: true,
            sound_enabled: false,
            agent_complete: true,
          },
          mcp: {
            default_protocol: 'stdio',
          },
        }
      },
    })
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    expect(store.agentRole).toBe('')
  })

  // ────────────────────────────────────────────────────
  // 2. 空状态：无消息时显示 EmptyState
  // ────────────────────────────────────────────────────
  it('shows empty state when there are no messages', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    // EmptyState 中包含 "开始对话" 文字
    expect(wrapper.text()).toContain('开始对话')
  })

  // ────────────────────────────────────────────────────
  // 3. 发送消息：用户输入并点击发送
  // ────────────────────────────────────────────────────
  it('sends a message when user types and clicks send', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    // Set model to pass the model-selection guard in useChatSend
    const { useChatStore } = await import('@/stores/chat')
    const chatStore = useChatStore()
    chatStore.chatParams.model = 'test-model'

    // 输入消息
    const textarea = wrapper.find('textarea')
    await textarea.setValue('测试消息')

    // 直接点击发送按钮，走 ChatInput -> sendHandler -> useChatSend 完整链路
    const sendButton = wrapper.find('.hc-composer__send')
    await sendButton.trigger('click')
    await flushPromises()

    // 用户消息应出现在列表中
    expect(wrapper.text()).toContain('测试消息')
  })

  // ────────────────────────────────────────────────────
  // 4. 显示接收到的消息
  // ────────────────────────────────────────────────────
  it('displays received messages in the message list', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    // 直接操作 store 模拟消息到达
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.messages.push(
      { id: 'u1', role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: '你好！有什么可以帮你的？', timestamp: '2026-01-01T00:00:01Z' },
    )
    await flushPromises()

    expect(wrapper.text()).toContain('你好')
    expect(wrapper.text()).toContain('你好！有什么可以帮你的？')
  })

  // ────────────────────────────────────────────────────
  // 5. 流式输出中显示 loading 状态
  // ────────────────────────────────────────────────────
  it('shows streaming indicator while waiting for response', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // 模拟流式输出状态
    store.currentSessionId = 'stream-session'
    store.streaming = true
    store.streamingSessionId = 'stream-session'
    store.streamingContent = ''
    // 需要至少有条消息才不走空状态分支
    store.messages.push({ id: 'u1', role: 'user', content: '问题', timestamp: '' })
    await flushPromises()

    // 流式区域应显示 typing 指示器或停止按钮
    const typingIndicator = wrapper.find('.hc-msg__typing')
    const stopBtn = wrapper.find('button[title="停止生成"]')
    // 至少有一个流式输出指示器
    expect(typingIndicator.exists() || stopBtn.exists()).toBe(true)
  })

  // ────────────────────────────────────────────────────
  // 6. 流式输出有内容时显示 MarkdownRenderer
  // ────────────────────────────────────────────────────
  it('shows streaming content via MarkdownRenderer when available', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.currentSessionId = 'stream-session'
    store.streaming = true
    store.streamingSessionId = 'stream-session'
    store.streamingContent = '正在生成的内容...'
    store.messages.push({ id: 'u1', role: 'user', content: '问题', timestamp: '' })
    await flushPromises()

    expect(wrapper.text()).toContain('正在生成的内容...')
  })

  // ────────────────────────────────────────────────────
  // 7. API 错误优雅处理
  // ────────────────────────────────────────────────────
  it('handles API error gracefully on sendMessage', async () => {
    const { sendChatViaBackend } = await import('@/api/chat')
    const mockedSend = vi.mocked(sendChatViaBackend)

    // 模拟 API 调用失败（WebSocket 和 HTTP 都失败）
    mockedSend.mockRejectedValueOnce(new Error('Network error'))

    mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('会失败的消息')
    await flushPromises()

    // 用户消息仍在列表中
    const userMsgs = store.messages.filter((m) => m.role === 'user')
    expect(userMsgs.length).toBeGreaterThanOrEqual(1)

    // 应有一条错误/助手消息
    const assistantMsgs = store.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

    // streaming 应已结束
    expect(store.streaming).toBe(false)
  })

  // ────────────────────────────────────────────────────
  // 8. 新建会话按钮
  // ────────────────────────────────────────────────────
  it('creates new session when new session button is clicked', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // 先模拟一个有消息的状态
    store.currentSessionId = 's1'
    store.messages.push({ id: 'u1', role: 'user', content: 'test', timestamp: '' })

    // 点击新建会话按钮
    const newBtn = wrapper.find('button[title="新建会话"]')
    expect(newBtn.exists()).toBe(true)
    await newBtn.trigger('click')

    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
  })

  // ────────────────────────────────────────────────────
  // 9. 会话列表侧栏渲染
  // ────────────────────────────────────────────────────
  it('renders session list sidebar', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    // "会话" 标题应可见
    expect(wrapper.text()).toContain('会话')

    // SessionList stub 应被渲染
    const sessionList = wrapper.find('[data-testid="session-list"]')
    expect(sessionList.exists()).toBe(true)
  })

  it('supports a draggable session sidebar width like ChatGPT', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const sidebar = wrapper.find('.hc-chat__sidebar')
    const resizer = wrapper.find('[role="separator"]')
    expect(sidebar.exists()).toBe(true)
    expect(resizer.exists()).toBe(true)
    expect(sidebar.attributes('style')).toContain('width: 260px;')

    await resizer.trigger('mousedown', { button: 0, clientX: 260 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 360 }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    await flushPromises()

    expect(wrapper.find('.hc-chat__sidebar').attributes('style')).toContain('width: 360px;')

    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(localStorage.getItem('hexclaw_chat_sidebar_width')).toBe('360')
  })

  it('copying a message should fail gracefully when clipboard API is unavailable', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push({
      id: 'u-copy',
      role: 'user',
      content: '复制这条消息',
      timestamp: '2026-01-01T00:00:00Z',
    })
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      ctxMsgIndex: number
      handleMsgCtxAction: (action: string) => Promise<void> | void
    }

    vm.ctxMsgIndex = 0

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    await expect(Promise.resolve(vm.handleMsgCtxAction('copy'))).resolves.toBeUndefined()
  })

  it('keeps message context-menu actions bound to the originally targeted message after list changes', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push(
      { id: 'u1', role: 'user', content: '第一条', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: '目标消息', timestamp: '2026-01-01T00:00:01Z' },
    )
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      ctxMsgId: string | null
      handleMsgCtxAction: (action: string) => Promise<void> | void
    }

    vm.ctxMsgId = 'a1'

    store.messages.unshift({
      id: 'u0',
      role: 'user',
      content: '新插入的消息',
      timestamp: '2026-01-01T00:00:02Z',
    })
    await flushPromises()

    await Promise.resolve(vm.handleMsgCtxAction('copy'))

    expect(setClipboard).toHaveBeenCalledWith('目标消息')
  })

  it('keeps the latest parsed document when an earlier parse resolves later', async () => {
    let resolveFirst!: (value: { text: string; fileName: string; pageCount?: number }) => void
    let resolveSecond!: (value: { text: string; fileName: string; pageCount?: number }) => void

    isDocumentFile.mockReturnValue(true)
    parseDocument
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )

    const wrapper = mountChatView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      handleFileUpload: (file: File) => Promise<void>
      parsedDocument: { text: string; fileName: string; pageCount?: number } | null
      documentParsing: boolean
    }

    const firstFile = new File(['first'], 'old.pdf', { type: 'application/pdf' })
    const secondFile = new File(['second'], 'new.pdf', { type: 'application/pdf' })

    void vm.handleFileUpload(firstFile)
    await flushPromises()
    void vm.handleFileUpload(secondFile)
    await flushPromises()

    resolveSecond({ text: 'new text', fileName: 'new.pdf', pageCount: 2 })
    await flushPromises()

    expect(vm.parsedDocument).toEqual({ text: 'new text', fileName: 'new.pdf', pageCount: 2 })

    resolveFirst({ text: 'old text', fileName: 'old.pdf', pageCount: 1 })
    await flushPromises()

    expect(vm.parsedDocument).toEqual({ text: 'new text', fileName: 'new.pdf', pageCount: 2 })
    expect(vm.documentParsing).toBe(false)
  })

  it('retries route query model selection until the downloaded Ollama model becomes visible', async () => {
    vi.useFakeTimers()
    mockRoute.query = { model: 'qwen3:8b' }
    mockGetOllamaStatus
      .mockResolvedValueOnce({ running: true, associated: true, model_count: 0, models: [] })
      .mockResolvedValueOnce({ running: true, associated: true, model_count: 0, models: [] })
      .mockResolvedValueOnce({
        running: true,
        associated: true,
        model_count: 1,
        models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
      })

    mountChatView({
      setup: () => {
        const settingsStore = useSettingsStore()
        settingsStore.config = {
          llm: {
            providers: [
              {
                id: 'ollama-local',
                name: 'Ollama',
                type: 'ollama',
                enabled: true,
                apiKey: '',
                baseUrl: 'http://127.0.0.1:11434/v1',
                backendKey: 'ollama',
                models: [],
                selectedModelId: '',
              },
            ],
            defaultModel: '',
            defaultProviderId: '',
            routing: { enabled: false, strategy: 'cost-aware' },
          },
          security: {
            gateway_enabled: true,
            injection_detection: true,
            pii_filter: false,
            content_filter: true,
            max_tokens_per_request: 8192,
            rate_limit_rpm: 60,
          },
          general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
          notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
          mcp: { default_protocol: 'stdio' },
        }
      },
    })
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const chatStore = useChatStore()
    expect(chatStore.chatParams.model).not.toBe('qwen3:8b')

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    expect(chatStore.chatParams.model).toBe('qwen3:8b')
    expect(mockRouterReplace).toHaveBeenCalledWith({ path: '/chat' })

    vi.useRealTimers()
  })

  it('keeps an in-flight stream alive when the chat view unmounts', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const chatStore = useChatStore()
    chatStore.streaming = true
    chatStore.streamingSessionId = 'session-background'
    chatStore.streamingContent = 'still generating'

    wrapper.unmount()

    expect(chatStore.streaming).toBe(true)
    expect(chatStore.streamingSessionId).toBe('session-background')
    expect(chatStore.streamingContent).toBe('still generating')
  })

  it('keeps the model query when the downloaded Ollama model is still not visible after retries', async () => {
    vi.useFakeTimers()
    mockRoute.query = { model: 'qwen3:8b' }
    mockGetOllamaStatus
      .mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })

    mountChatView({
      setup: () => {
        const settingsStore = useSettingsStore()
        settingsStore.config = {
          llm: {
            providers: [
              {
                id: 'ollama-local',
                name: 'Ollama',
                type: 'ollama',
                enabled: true,
                apiKey: '',
                baseUrl: 'http://127.0.0.1:11434/v1',
                backendKey: 'ollama',
                models: [],
                selectedModelId: '',
              },
            ],
            defaultModel: '',
            defaultProviderId: '',
            routing: { enabled: false, strategy: 'cost-aware' },
          },
          security: {
            gateway_enabled: true,
            injection_detection: true,
            pii_filter: false,
            content_filter: true,
            max_tokens_per_request: 8192,
            rate_limit_rpm: 60,
          },
          general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
          notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
          mcp: { default_protocol: 'stdio' },
        }
      },
    })
    await flushPromises()

    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const chatStore = useChatStore()
    expect(chatStore.chatParams.model).not.toBe('qwen3:8b')
    expect(mockRouterReplace).not.toHaveBeenCalledWith({ path: '/chat' })

    vi.useRealTimers()
  })

  it('initializes the default model before session loading settles so the first send is not dropped', async () => {
    const pending = new Promise<void>(() => {})
    let sendSpy: ReturnType<typeof vi.spyOn> | null = null

    const wrapper = mountChatView({
      setup: () => {
        const chatStore = useChatStore()
        vi.spyOn(chatStore, 'loadSessions').mockImplementation(() => pending)
        vi.spyOn(chatStore, 'recoverActiveStreams').mockImplementation(() => pending)
        sendSpy = vi.spyOn(chatStore, 'sendMessage').mockResolvedValue(null)

        const settingsStore = useSettingsStore()
        settingsStore.config = {
          llm: {
            providers: [
              {
                id: 'deepseek-provider',
                name: 'DeepSeek',
                type: 'deepseek',
                enabled: true,
                apiKey: '',
                baseUrl: 'https://api.deepseek.com',
                backendKey: 'deepseek',
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: ['text'] }],
                selectedModelId: 'deepseek-chat',
              },
            ],
            defaultModel: 'deepseek-chat',
            defaultProviderId: 'deepseek-provider',
            routing: { enabled: false, strategy: 'cost-aware' },
          },
          security: {
            gateway_enabled: true,
            injection_detection: true,
            pii_filter: false,
            content_filter: true,
            max_tokens_per_request: 8192,
            rate_limit_rpm: 60,
          },
          general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
          notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
          mcp: { default_protocol: 'stdio' },
          memory: { enabled: true },
        }
      },
    })
    await flushPromises()

    const chatStore = useChatStore()
    expect(chatStore.chatParams.model).toBe('deepseek-chat')

    await wrapper.find('textarea').setValue('立即发送')
    await wrapper.find('.hc-composer__send').trigger('click')
    await flushPromises()

    expect(sendSpy).toHaveBeenCalledWith('立即发送', undefined, undefined)
  })
})
