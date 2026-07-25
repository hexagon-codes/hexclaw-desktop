import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import k12ZhCN from '@/features/k12/i18n/zh-CN'
import { K12_VIEW_DESCRIPTOR } from '@/features/k12/descriptor'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import {
  bindSessionAgent,
  clearSessionAgent,
  getSessionAgent,
} from '@/stores/session-agent-binding'
import { clearSessionDeepThinking } from '@/stores/session-thinking-preference'
import {
  scenarioRegistry,
  type ScenarioComposerImagePayload,
} from '@/shell/scenario/registry'

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

const { mockGetConnections, mockGetConnectionsResult } = vi.hoisted(() => ({
  mockGetConnections: vi.fn(),
  mockGetConnectionsResult: vi.fn(),
}))

const { mockAppendSessionMessage, mockAppendSessionMessagesBatch } = vi.hoisted(() => ({
  mockAppendSessionMessage: vi.fn().mockResolvedValue({
    id: 'scenario-image-message',
    session_id: 'scenario-session',
  }),
  mockAppendSessionMessagesBatch: vi.fn().mockResolvedValue({
    ids: [],
    session_id: 'scenario-session',
  }),
}))

const { mockForkSession, mockDeleteSession } = vi.hoisted(() => ({
  mockForkSession: vi.fn().mockResolvedValue({ session: { id: 'edited-image-branch' } }),
  mockDeleteSession: vi.fn().mockResolvedValue({ message: 'ok' }),
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
  appendSessionMessage: mockAppendSessionMessage,
  appendSessionMessagesBatch: mockAppendSessionMessagesBatch,
  forkSession: mockForkSession,
  deleteSession: mockDeleteSession,
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

vi.mock('@/api/im-channels', () => ({
  getConnections: () => mockGetConnections(),
  getConnectionsResult: () => mockGetConnectionsResult(),
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
    messages: {
      'zh-CN': { ...zhCN, k12: k12ZhCN },
      zh: { ...zhCN, k12: k12ZhCN },
    },
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
function mountChatView(options?: {
  setup?: () => void
  attachTo?: HTMLElement
}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  options?.setup?.()
  const i18n = createTestI18n()

  return mount(ChatView, {
    attachTo: options?.attachTo,
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

function chatEditor(wrapper: ReturnType<typeof mountChatView>) {
  return wrapper.get<HTMLElement>('[data-testid="chat-input"]')
}

async function setChatDraft(wrapper: ReturnType<typeof mountChatView>, value: string) {
  const editor = chatEditor(wrapper)
  editor.element.textContent = value
  await editor.trigger('input')
  await wrapper.vm.$nextTick()
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
    mockGetConnections.mockResolvedValue([])
    mockGetConnectionsResult.mockResolvedValue({ connections: [] })
    mockForkSession.mockResolvedValue({ session: { id: 'edited-image-branch' } })
    mockDeleteSession.mockResolvedValue({ message: 'ok' })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  // ────────────────────────────────────────────────────
  // 1. 渲染：输入框和发送按钮
  // ────────────────────────────────────────────────────
  it('renders the canonical rich-text chat input and send button', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const editor = chatEditor(wrapper)
    expect(editor.attributes('contenteditable')).toBe('true')

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

  it('[bug] distinguishes connection-directory failure from a successful empty list', async () => {
    mockGetConnectionsResult.mockResolvedValueOnce({
      connections: [],
      error: 'sidecar unavailable',
    })
    const wrapper = mountChatView()
    await flushPromises()

    expect(mockGetConnectionsResult).toHaveBeenCalled()
    expect(mockGetConnections).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="chat-connections-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-connections-empty"]').exists()).toBe(false)
  })

  it('shows a distinct empty state after the connection directory loads successfully', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    expect(wrapper.find('[data-testid="chat-connections-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-connections-error"]').exists()).toBe(false)
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

    await setChatDraft(wrapper, '测试消息')

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

  // 2026-06-27 会话滚动行为：会话级=瞬时到底(auto)；会话内=平滑(smooth)+尊重滚动位置。
  it('opening a conversation jumps to bottom INSTANTLY (scrollIntoView behavior=auto)', async () => {
    mountChatView()
    await flushPromises()
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    scrollSpy.mockClear()

    // 模拟「打开/切换会话」：currentSessionId 先变（早于消息异步落地），再整体替换 messages 数组。
    store.currentSessionId = 'opened-session'
    await flushPromises()
    store.messages = [
      { id: 'u1', role: 'user', content: '历史问题', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: '历史回答', timestamp: '2026-01-01T00:00:01Z' },
    ]
    await flushPromises()

    const behaviors = scrollSpy.mock.calls.map((c) => (c[0] as { behavior?: string } | undefined)?.behavior)
    expect(behaviors).toContain('auto') // 会话级=瞬时到底（无动画）
  }, 10000)

  it('appending a message WITHIN a session scrolls smoothly (behavior=smooth), not instant', async () => {
    mountChatView()
    await flushPromises()
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.currentSessionId = 'sess'
    store.messages = [{ id: 'a1', role: 'assistant', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }] // open
    await flushPromises()

    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    scrollSpy.mockClear()
    // 会话内追加（push，同引用）→ 走 length watcher 平滑滚动
    store.messages.push({ id: 'u2', role: 'user', content: '追问', timestamp: '2026-01-01T00:00:02Z' })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 150)) // scrollToBottom 节流 100ms

    const behaviors = scrollSpy.mock.calls.map((c) => (c[0] as { behavior?: string } | undefined)?.behavior)
    expect(behaviors).toContain('smooth') // 会话内=平滑
    expect(behaviors).not.toContain('auto') // 会话内不用瞬时
  }, 10000)

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

  it('BUG-20260629 sending 但首个 token 未到时立即显示 assistant pending 气泡', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.currentSessionId = 'pending-session'
    store.sending = true
    store.streaming = false
    store.streamingContent = ''
    store.messages.push({ id: 'u1', role: 'user', content: '问题', timestamp: '' })
    await flushPromises()

    expect(wrapper.find('.hc-typing-dots').exists()).toBe(true)
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

  // BUG（用户反馈 2026-06-28）：编辑用户消息时，原本挂载的 skill 在编辑卡片里不显示，像是丢了。
  it('编辑态下编辑卡片仍显示原消息挂载的 skill chip', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push({
      id: 'u-skill',
      role: 'user',
      content: '你吃饭了吗?',
      timestamp: '2026-01-01T00:00:00Z',
      metadata: { skills: ['girlfriend'] },
    })
    await flushPromises()

    const vm = wrapper.vm as unknown as { editingMsgId: string | null }
    vm.editingMsgId = 'u-skill'
    await flushPromises()

    const editCard = wrapper.find('.hc-msg__edit-card')
    expect(editCard.exists()).toBe(true)
    // 修复前：编辑卡片只渲染图片附件、漏了 skill → 此断言 RED。
    expect(editCard.find('.hc-msg__edit-skills').exists()).toBe(true)
    expect(editCard.text()).toContain('girlfriend')
  })

  it('编辑含公式的用户消息时复用 canonical 公式投影而不是退回 raw TeX textarea', async () => {
    const source = String.raw`第一天修了 $2\frac{3}{4}$ 千米，第二天多修 $1\frac{1}{2}$ 千米。`
    const wrapper = mountChatView({ attachTo: document.body })
    await flushPromises()

    const store = useChatStore()
    store.messages.push({
      id: 'u-math-edit',
      role: 'user',
      content: source,
      timestamp: '2026-07-24T00:00:00Z',
    })
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      editingMsgId: string | null
      editingText: string
    }
    vm.editingMsgId = 'u-math-edit'
    vm.editingText = source
    await flushPromises()

    const editCard = wrapper.get('.hc-msg__edit-card')
    const editor = editCard.get('[data-testid="message-math-editor"]')
    expect(editCard.find('textarea').exists()).toBe(false)
    expect(editor.attributes('data-canonical-source')).toBe(source)
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(2)
    expect(
      editor
        .findAll('annotation[encoding="application/x-tex"]')
        .map((annotation) => annotation.text()),
    ).toEqual([String.raw`2\frac{3}{4}`, String.raw`1\frac{1}{2}`])

    wrapper.unmount()
  })

  it('BUG-20260724-002 场景图片形成恰一条持久用户消息且不调用普通 chat', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const store = useChatStore()
    store.currentSessionId = 'scenario-session'
    ;(
      wrapper.vm as unknown as {
        selectModel: (
          modelId: string,
          providerId: string,
          providerKey: string,
          providerName: string,
        ) => void
      }
    ).selectModel('gpt-5.6-sol', 'provider-config-id', 'hexclaw-gpt', 'HexClaw GPT')
    const sendSpy = vi.spyOn(store, 'sendMessage')
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const payload = {
      dataUrl,
      attachment: {
        type: 'image' as const,
        name: 'homework.png',
        mime: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    }

    wrapper.getComponent({ name: 'ChatInput' }).vm.$emit('scenario-image', payload)

    await vi.waitFor(() => {
      expect(mockAppendSessionMessage).toHaveBeenCalledTimes(1)
    })
    const imageMessages = store.messages.filter(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.metadata?.attachments) &&
        message.metadata.attachments.some(
          (attachment) =>
            (attachment as { type?: string; data?: string }).type === 'image' &&
            (attachment as { data?: string }).data === payload.attachment.data,
        ),
    )
    expect(imageMessages).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="chat-message-user"] img')).toHaveLength(1)
    expect(mockAppendSessionMessage).toHaveBeenCalledWith(
      'scenario-session',
      expect.objectContaining({
        id: imageMessages[0]!.id,
        role: 'user',
        content: '',
        metadata: { attachments: [payload.attachment] },
      }),
    )
    expect(sendSpy).not.toHaveBeenCalled()
    expect(
      (
        wrapper.vm as unknown as {
          scenarioComposerImage: {
            dataUrl: string
            attachment: { type: string; name: string; mime: string; data: string }
            requestId?: string
            route?: { provider: string; model: string; capability: string }
          }
        }
      ).scenarioComposerImage,
    ).toEqual({
      ...payload,
      requestId: imageMessages[0]!.id,
      sourceSessionId: 'scenario-session',
      route: {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        capability: 'vision',
      },
    })

    wrapper.unmount()
  })

  it('BUG-20260724-010 编辑纯图片消息会以新消息身份重新进入既有场景图片管道', async () => {
    const descriptor = {
      schemaVersion: '1',
      headerTabs: [{ id: 'chat', labelKey: 'chat.title', kind: 'chat' }],
      messageBadges: [],
      recordCollections: [],
      sidePanels: [],
      actions: [],
    }
    scenarioRegistry.registerResolver((ctx) =>
      ctx.metadata?.scenario === 'edit-image-test' ? descriptor as never : null,
    )
    scenarioRegistry.registerChatEnhancement({
      name: 'EditImageScenarioStub',
      template: '<div />',
    })

    const wrapper = mountChatView({
      setup: () => {
        useAgentsStore().registeredAgents = [
          {
            name: 'edit-image-agent',
            display_name: '图片场景',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
            metadata: { scenario: 'edit-image-test' },
          },
        ]
      },
    })

    try {
      await flushPromises()
      const store = useChatStore()
      store.currentSessionId = 'edit-image-session'
      store.agentRole = 'edit-image-agent'
      store.chatMode = 'agent'
      vi.spyOn(store, 'loadSessions').mockResolvedValue(undefined)
      vi.spyOn(store, 'selectSession').mockImplementation(async (sessionId: string) => {
        store.currentSessionId = sessionId
        store.agentRole = getSessionAgent(sessionId)
        store.chatMode = store.agentRole ? 'agent' : 'chat'
        store.messages.splice(0)
      })
      const attachment = {
        type: 'image' as const,
        name: 'homework.png',
        mime: 'image/png',
        data: 'aG9tZXdvcms=',
      }
      store.messages.push(
        {
          id: 'original-image-message',
          role: 'user',
          content: '',
          timestamp: '2026-07-24T00:00:00Z',
          metadata: { attachments: [attachment] },
        },
        {
          id: 'later-assistant-message',
          role: 'assistant',
          content: '原来的回复',
          timestamp: '2026-07-24T00:00:01Z',
          metadata: {},
        },
      )
      await flushPromises()

      const vm = wrapper.vm as unknown as {
        editingMsgId: string | null
        editingText: string
        confirmEdit: (messageId: string) => Promise<void>
        scenarioComposerImage: {
          dataUrl: string
          requestId?: string
          attachment: typeof attachment
        } | ''
      }
      vm.editingMsgId = 'original-image-message'
      vm.editingText = ''
      await vm.confirmEdit('original-image-message')

      await vi.waitFor(() => {
        expect(mockAppendSessionMessage).toHaveBeenCalledTimes(1)
      })
      expect(mockForkSession).toHaveBeenCalledWith('edit-image-session', 'original-image-message', {
        includeMessage: false,
      })
      expect(store.currentSessionId).toBe('edited-image-branch')
      expect(store.agentRole).toBe('edit-image-agent')
      expect(store.messages).toHaveLength(1)
      const revisedMessage = store.messages[0]!
      expect(revisedMessage.id).not.toBe('original-image-message')
      expect(revisedMessage.metadata?.attachments).toEqual([attachment])
      expect(mockAppendSessionMessage).toHaveBeenCalledWith(
        'edited-image-branch',
        expect.objectContaining({ id: revisedMessage.id, content: '', metadata: { attachments: [attachment] } }),
      )
      expect(vm.scenarioComposerImage).toEqual({
        dataUrl: 'data:image/png;base64,aG9tZXdvcms=',
        attachment,
        contextText: '',
        requestId: revisedMessage.id,
        sourceSessionId: 'edited-image-branch',
        route: {
          provider: 'hexclaw-gpt',
          model: 'gpt-5.6-sol',
          capability: 'vision',
        },
      })
    } finally {
      wrapper.unmount()
      scenarioRegistry.reset()
    }
  })

  it('BUG-20260724-010 编辑带说明的图片消息仍进入场景管道并原样保留说明与历史', async () => {
    const descriptor = {
      schemaVersion: '1',
      headerTabs: [{ id: 'chat', labelKey: 'chat.title', kind: 'chat' }],
      messageBadges: [],
      recordCollections: [],
      sidePanels: [],
      actions: [],
    }
    scenarioRegistry.registerResolver((ctx) =>
      ctx.metadata?.scenario === 'edit-image-with-text-test' ? (descriptor as never) : null,
    )
    scenarioRegistry.registerChatEnhancement({
      name: 'EditImageWithTextScenarioStub',
      template: '<div />',
    })

    const wrapper = mountChatView({
      setup: () => {
        useAgentsStore().registeredAgents = [
          {
            name: 'edit-image-with-text-agent',
            display_name: '图片场景',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
            metadata: { scenario: 'edit-image-with-text-test' },
          },
        ]
      },
    })

    try {
      await flushPromises()
      const store = useChatStore()
      store.currentSessionId = 'edit-image-with-text-session'
      store.agentRole = 'edit-image-with-text-agent'
      store.chatMode = 'agent'
      vi.spyOn(store, 'loadSessions').mockResolvedValue(undefined)
      vi.spyOn(store, 'selectSession').mockImplementation(async (sessionId: string) => {
        store.currentSessionId = sessionId
        store.agentRole = getSessionAgent(sessionId)
        store.chatMode = store.agentRole ? 'agent' : 'chat'
        store.messages.splice(0)
      })
      const attachment = {
        type: 'image' as const,
        name: 'homework-with-note.png',
        mime: 'image/png',
        data: 'aG9tZXdvcmstd2l0aC1ub3Rl',
      }
      store.messages.push(
        {
          id: 'original-image-with-text',
          role: 'user',
          content: '请批改这一页',
          timestamp: '2026-07-24T00:00:00Z',
          metadata: { attachments: [attachment] },
        },
        {
          id: 'preserved-tail',
          role: 'assistant',
          content: '旧回复必须保留',
          timestamp: '2026-07-24T00:00:01Z',
          metadata: {},
        },
      )
      await flushPromises()

      const vm = wrapper.vm as unknown as {
        editingMsgId: string | null
        editingText: string
        confirmEdit: (messageId: string) => Promise<void>
        scenarioComposerImage: ScenarioComposerImagePayload | ''
      }
      vm.editingMsgId = 'original-image-with-text'
      vm.editingText = '请按五年级方法详细讲解'
      await vm.confirmEdit('original-image-with-text')

      await vi.waitFor(() => {
        expect(mockAppendSessionMessage).toHaveBeenCalledTimes(1)
      })
      expect(mockForkSession).toHaveBeenCalledWith('edit-image-with-text-session', 'original-image-with-text', {
        includeMessage: false,
      })
      expect(store.currentSessionId).toBe('edited-image-branch')
      expect(store.agentRole).toBe('edit-image-with-text-agent')
      expect(store.messages).toHaveLength(1)
      const revisedMessage = store.messages[0]!
      expect(revisedMessage.content).toBe('请按五年级方法详细讲解')
      expect(revisedMessage.metadata?.attachments).toEqual([attachment])
      expect(mockAppendSessionMessage).toHaveBeenCalledWith(
        'edited-image-branch',
        expect.objectContaining({
          id: revisedMessage.id,
          content: '请按五年级方法详细讲解',
          metadata: { attachments: [attachment] },
        }),
      )
      expect(vm.scenarioComposerImage).toMatchObject({
        dataUrl: 'data:image/png;base64,aG9tZXdvcmstd2l0aC1ub3Rl',
        attachment,
        contextText: '请按五年级方法详细讲解',
        requestId: revisedMessage.id,
        route: {
          provider: 'hexclaw-gpt',
          model: 'gpt-5.6-sol',
          capability: 'vision',
        },
      })
    } finally {
      wrapper.unmount()
      scenarioRegistry.reset()
    }
  })

  it('BUG-20260724-010 图片编辑提交迟到时不会投影到用户已切换的同 Agent 会话', async () => {
    const descriptor = {
      schemaVersion: '1',
      headerTabs: [{ id: 'chat', labelKey: 'chat.title', kind: 'chat' }],
      messageBadges: [],
      recordCollections: [],
      sidePanels: [],
      actions: [],
    }
    scenarioRegistry.registerResolver((ctx) =>
      ctx.metadata?.scenario === 'edit-image-session-race-test' ? (descriptor as never) : null,
    )
    scenarioRegistry.registerChatEnhancement({
      name: 'EditImageSessionRaceStub',
      template: '<div />',
    })

    let releasePersist!: () => void
    mockAppendSessionMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePersist = () =>
            resolve({
              id: 'revised-image-message',
              session_id: 'edited-image-branch',
            })
        }),
    )
    const wrapper = mountChatView({
      setup: () => {
        useAgentsStore().registeredAgents = [
          {
            name: 'edit-image-session-race-agent',
            display_name: '图片场景',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
            metadata: { scenario: 'edit-image-session-race-test' },
          },
        ]
      },
    })

    try {
      await flushPromises()
      const store = useChatStore()
      store.currentSessionId = 'edit-image-source-session'
      store.agentRole = 'edit-image-session-race-agent'
      store.chatMode = 'agent'
      vi.spyOn(store, 'loadSessions').mockResolvedValue(undefined)
      vi.spyOn(store, 'selectSession').mockImplementation(async (sessionId: string) => {
        store.currentSessionId = sessionId
        store.agentRole = 'edit-image-session-race-agent'
        store.chatMode = 'agent'
        store.messages.splice(0)
      })
      const attachment = {
        type: 'image' as const,
        name: 'homework-race.png',
        mime: 'image/png',
        data: 'cmFjZS1pbWFnZQ==',
      }
      store.messages.push({
        id: 'original-race-image',
        role: 'user',
        content: '',
        timestamp: '2026-07-24T00:00:00Z',
        metadata: { attachments: [attachment] },
      })
      await flushPromises()

      const vm = wrapper.vm as unknown as {
        editingMsgId: string | null
        editingText: string
        confirmEdit: (messageId: string) => Promise<void>
        scenarioComposerImage: ScenarioComposerImagePayload | ''
      }
      vm.editingMsgId = 'original-race-image'
      vm.editingText = ''
      const pending = vm.confirmEdit('original-race-image')
      await vi.waitFor(() => {
        expect(mockForkSession).toHaveBeenCalledWith(
          'edit-image-source-session',
          'original-race-image',
          { includeMessage: false },
        )
      })
      await vi.waitFor(() => {
        expect(mockAppendSessionMessage).toHaveBeenCalledWith(
          'edited-image-branch',
          expect.objectContaining({ metadata: { attachments: [attachment] } }),
        )
      })

      await store.selectSession('other-same-agent-session')
      releasePersist()
      await pending

      // The accepted attempt belongs to the edit branch. Its late completion may
      // update that branch's persisted state, but must not activate a scenario
      // panel in another session merely because both sessions share one Agent.
      expect(store.currentSessionId).toBe('other-same-agent-session')
      expect(vm.scenarioComposerImage).toBe('')
      expect(mockDeleteSession).not.toHaveBeenCalledWith('edited-image-branch')

      // The accepted attempt remains owned by/recoverable from its actual branch.
      await store.selectSession('edited-image-branch')
      await flushPromises()
      expect(vm.scenarioComposerImage).toMatchObject({
        requestId: expect.any(String),
        sourceSessionId: 'edited-image-branch',
        attachment,
      })
    } finally {
      wrapper.unmount()
      scenarioRegistry.reset()
    }
  })

  it('BUG-20260724-003 未手动选模时仍冻结全局默认视觉路由', async () => {
    const wrapper = mountChatView({
      setup: () => {
        const settingsStore = useSettingsStore()
        settingsStore.config = {
          llm: {
            providers: [
              {
                id: 'sol-provider-id',
                name: 'HexClaw GPT',
                type: 'openai',
                enabled: true,
                apiKey: '',
                baseUrl: 'https://example.invalid/v1',
                backendKey: 'hexclaw-gpt',
                models: [
                  {
                    id: 'gpt-5.6-sol',
                    name: 'gpt-5.6-sol',
                    capabilities: ['text', 'vision'],
                  },
                ],
                selectedModelId: 'gpt-5.6-sol',
              },
            ],
            defaultModel: 'gpt-5.6-sol',
            defaultProviderId: 'sol-provider-id',
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
          general: {
            language: 'zh-CN',
            log_level: 'info',
            data_dir: '',
            auto_start: false,
            defaultAgentRole: '',
          },
          notification: {
            system_enabled: true,
            sound_enabled: false,
            agent_complete: true,
          },
          mcp: { default_protocol: 'stdio' },
        }
      },
    })
    await flushPromises()

    const store = useChatStore()
    store.currentSessionId = 'default-route-session'
    wrapper.getComponent({ name: 'ChatInput' }).vm.$emit('scenario-image', {
      dataUrl: 'data:image/png;base64,ZGVmYXVsdA==',
      attachment: {
        type: 'image',
        name: 'default.png',
        mime: 'image/png',
        data: 'ZGVmYXVsdA==',
      },
    })

    await vi.waitFor(() => {
      expect(
        (
          wrapper.vm as unknown as {
            scenarioComposerImage: {
              requestId?: string
              route?: { provider: string; model: string; capability: string }
            }
          }
        ).scenarioComposerImage.route,
      ).toEqual({
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        capability: 'vision',
      })
    })

    wrapper.unmount()
  })

  it('BUG-20260724-003 未手动选模时冻结智能体绑定路由而非全局默认路由', async () => {
    const wrapper = mountChatView({
      setup: () => {
        useAgentsStore().registeredAgents = [
          {
            name: 'k12-tutor-mingming',
            display_name: '小明的辅导助手',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
          },
        ]
      },
    })
    await flushPromises()

    const store = useChatStore()
    store.currentSessionId = 'agent-route-session'
    store.agentRole = 'k12-tutor-mingming'
    store.chatMode = 'agent'
    await flushPromises()
    wrapper.getComponent({ name: 'ChatInput' }).vm.$emit('scenario-image', {
      dataUrl: 'data:image/png;base64,YWdlbnQ=',
      attachment: {
        type: 'image',
        name: 'agent.png',
        mime: 'image/png',
        data: 'YWdlbnQ=',
      },
    })

    await vi.waitFor(() => {
      expect(
        (
          wrapper.vm as unknown as {
            scenarioComposerImage: {
              requestId?: string
              route?: { provider: string; model: string; capability: string }
            }
          }
        ).scenarioComposerImage.route,
      ).toEqual({
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        capability: 'vision',
      })
    })

    wrapper.unmount()
  })

  it('BUG-20260724-003 旧失败图片显式重试会用新消息身份和点击时当前路由创建唯一新 attempt', async () => {
    const descriptor = {
      schemaVersion: '1',
      headerTabs: [{ id: 'chat', labelKey: 'chat.title', kind: 'chat' }],
      messageBadges: [],
      recordCollections: [],
      sidePanels: [],
      actions: [],
    }
    scenarioRegistry.registerResolver((ctx) =>
      ctx.metadata?.scenario === 'attempt-retry-test' ? (descriptor as never) : null,
    )
    scenarioRegistry.registerChatEnhancement({
      name: 'AttemptRetryScenarioStub',
      props: ['composerImage'],
      emits: ['scenarioImageAttempt'],
      template: '<button data-testid="retry-attempt" />',
    })

    const wrapper = mountChatView({
      setup: () => {
        useAgentsStore().registeredAgents = [
          {
            name: 'attempt-retry-agent',
            display_name: '重试模型助手',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.3-codex-spark',
            metadata: { scenario: 'attempt-retry-test' },
          },
        ]
      },
    })

    try {
      await flushPromises()
      const store = useChatStore()
      const agents = useAgentsStore()
      store.currentSessionId = 'attempt-retry-session'
      store.agentRole = 'attempt-retry-agent'
      store.chatMode = 'agent'
      const original = {
        dataUrl: 'data:image/png;base64,cmV0cnk=',
        attachment: {
          type: 'image' as const,
          name: 'retry.png',
          mime: 'image/png',
          data: 'cmV0cnk=',
        },
      }
      wrapper.getComponent({ name: 'ChatInput' }).vm.$emit('scenario-image', original)

      await vi.waitFor(() => {
        expect(mockAppendSessionMessage).toHaveBeenCalledTimes(1)
      })
      const enhancement = wrapper.getComponent({ name: 'AttemptRetryScenarioStub' })
      const frozenOldAttempt = enhancement.props('composerImage') as {
        requestId: string
        route: { provider: string; model: string; capability: string }
      }
      expect(frozenOldAttempt.route.model).toBe('gpt-5.3-codex-spark')

      // 旧 Job/消息的快照保持不变；家长在重试前已把当前绑定切到新模型。
      agents.registeredAgents[0]!.model = 'gpt-5.6-sol'
      await flushPromises()
      enhancement.vm.$emit('scenarioImageAttempt', enhancement.props('composerImage'))
      enhancement.vm.$emit('scenarioImageAttempt', enhancement.props('composerImage'))

      await vi.waitFor(() => {
        expect(mockAppendSessionMessage).toHaveBeenCalledTimes(2)
      })
      const imageMessages = store.messages.filter(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.metadata?.attachments) &&
          message.metadata.attachments.some(
            (attachment) => (attachment as { data?: string }).data === 'cmV0cnk=',
          ),
      )
      expect(imageMessages).toHaveLength(2)
      expect(imageMessages[1]!.id).not.toBe(frozenOldAttempt.requestId)
      expect(frozenOldAttempt.route.model).toBe('gpt-5.3-codex-spark')
      expect(
        (
          wrapper.vm as unknown as {
            scenarioComposerImage: {
              requestId: string
              route: { provider: string; model: string; capability: string }
            }
          }
        ).scenarioComposerImage,
      ).toMatchObject({
        requestId: imageMessages[1]!.id,
        route: {
          provider: 'hexclaw-gpt',
          model: 'gpt-5.6-sol',
          capability: 'vision',
        },
      })
    } finally {
      wrapper.unmount()
      scenarioRegistry.reset()
    }
  })

  it('BUG-20260724-002 新会话首图等待稳定 session 后才启动场景且仍只持久化一次', async () => {
    const wrapper = mountChatView()
    await flushPromises()

    const store = useChatStore()
    expect(store.currentSessionId).toBeNull()
    let releaseSession!: () => void
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve
    })
    vi.spyOn(store, 'ensureSession').mockImplementation(async () => {
      await sessionGate
      store.currentSessionId = 'fresh-scenario-session'
      return 'fresh-scenario-session'
    })
    const payload = {
      dataUrl: 'data:image/png;base64,Zmlyc3Q=',
      attachment: {
        type: 'image' as const,
        name: 'first.png',
        mime: 'image/png',
        data: 'Zmlyc3Q=',
      },
    }

    wrapper.getComponent({ name: 'ChatInput' }).vm.$emit('scenario-image', payload)
    await flushPromises()

    expect(
      store.messages.filter(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.metadata?.attachments) &&
          message.metadata.attachments.some(
            (attachment) => (attachment as { data?: string }).data === payload.attachment.data,
          ),
      ),
    ).toHaveLength(1)
    expect(
      (
        wrapper.vm as unknown as {
          scenarioComposerImage: unknown
        }
      ).scenarioComposerImage,
    ).toBe('')
    expect(mockAppendSessionMessage).not.toHaveBeenCalled()

    releaseSession()
    await vi.waitFor(() => {
      expect(mockAppendSessionMessage).toHaveBeenCalledTimes(1)
    })
    expect(mockAppendSessionMessage).toHaveBeenCalledWith(
      'fresh-scenario-session',
      expect.objectContaining({ role: 'user', metadata: { attachments: [payload.attachment] } }),
    )
    expect(
      (
        wrapper.vm as unknown as {
          scenarioComposerImage: { dataUrl: string }
        }
      ).scenarioComposerImage.dataUrl,
    ).toBe(payload.dataUrl)

    wrapper.unmount()
  })

  it('BUG-20260724-006 深度思考保留已绑定 Agent 的模型显示与后端模型决策', async () => {
    const wrapper = mountChatView({
      setup: () => {
        const settingsStore = useSettingsStore()
        settingsStore.config = {
          llm: {
            providers: [
              {
                id: 'global-provider-id',
                name: 'Global',
                type: 'openai',
                enabled: true,
                apiKey: '',
                baseUrl: 'https://example.invalid/v1',
                backendKey: 'global-provider',
                models: [
                  {
                    id: 'global-default-model',
                    name: 'Global Default',
                    capabilities: ['text'],
                  },
                ],
                selectedModelId: 'global-default-model',
              },
            ],
            defaultModel: 'global-default-model',
            defaultProviderId: 'global-provider-id',
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
          general: {
            language: 'zh-CN',
            log_level: 'info',
            data_dir: '',
            auto_start: false,
            defaultAgentRole: '',
          },
          notification: {
            system_enabled: true,
            sound_enabled: false,
            agent_complete: true,
          },
          mcp: { default_protocol: 'stdio' },
        }
        useAgentsStore().registeredAgents = [
          {
            name: 'k12-tutor-mingming',
            display_name: '小明的辅导助手',
            model: 'gpt-5.6-sol',
            provider: 'hexclaw-gpt',
          },
        ]
      },
    })
    await flushPromises()

    const store = useChatStore()
    store.agentRole = 'k12-tutor-mingming'
    store.chatMode = 'agent'
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      selectedModelDisplay: string
      syncChatParams: () => void
      toggleDeepThinking: () => void
    }
    vm.syncChatParams()
    expect(vm.selectedModelDisplay).toBe('gpt-5.6-sol · 小明的辅导助手')
    expect(store.chatParams.provider).toBeUndefined()
    expect(store.chatParams.model).toBeUndefined()

    vm.toggleDeepThinking()
    await flushPromises()

    expect(store.chatMode).toBe('research')
    expect(store.agentRole).toBe('k12-tutor-mingming')
    expect(vm.selectedModelDisplay).toBe('gpt-5.6-sol · 小明的辅导助手')
    expect(store.chatParams.provider).toBeUndefined()
    expect(store.chatParams.model).toBeUndefined()

    wrapper.unmount()
  })

  it('绑定 K12 会话开启深度思考并发送后，切走再切回仍保留三枚 Skill chips 与场景提示语', async () => {
    const k12SessionId = 'k12-thinking-composer-session'
    const ordinarySessionId = 'ordinary-thinking-composer-session'
    const k12AgentId = 'k12-tutor-mingming'
    const expectedChips = ['📚 自动识别学科', '💡 渐进提示', '📷 识题校验']
    const expectedPlaceholder = '发消息、粘贴带分数/公式的题目，或 ⌘V 粘贴作业照片'

    scenarioRegistry.reset()
    scenarioRegistry.registerResolver((ctx) =>
      ctx.metadata?.scenario === 'k12-tutor' ? K12_VIEW_DESCRIPTOR : null,
    )
    scenarioRegistry.registerChatEnhancement({
      name: 'K12ComposerStateIntegrationStub',
      emits: ['update:composerChips'],
      mounted() {
        this.$emit('update:composerChips', expectedChips)
      },
      template: '<div data-testid="k12-composer-state-integration" />',
    })
    bindSessionAgent(k12SessionId, k12AgentId)

    const wrapper = mountChatView({
      setup: () => {
        useAgentsStore().registeredAgents = [
          {
            name: k12AgentId,
            display_name: '小明的辅导助手',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
            metadata: {
              scenario: 'k12-tutor',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
            },
          },
        ]
      },
    })

    const expectK12Composer = async () => {
      await vi.waitFor(() => {
        expect(wrapper.findAll('[data-testid="composer-preset-chip"]')).toHaveLength(3)
      })
      expect(
        wrapper
          .findAll('[data-testid="composer-preset-chip"]')
          .map((chip) => chip.text().replace(/×$/, '').trim()),
      ).toEqual(expectedChips)
      expect(chatEditor(wrapper).attributes('data-placeholder')).toBe(expectedPlaceholder)
    }

    try {
      await flushPromises()
      const store = useChatStore()
      store.sessions = [
        {
          id: k12SessionId,
          title: '小明的辅导助手',
          created_at: '2026-07-25T00:00:00Z',
          updated_at: '2026-07-25T00:00:00Z',
          message_count: 0,
        },
        {
          id: ordinarySessionId,
          title: '普通会话',
          created_at: '2026-07-25T00:00:01Z',
          updated_at: '2026-07-25T00:00:01Z',
          message_count: 0,
        },
      ]

      await store.selectSession(k12SessionId)
      await flushPromises()
      expect(store.agentRole).toBe(k12AgentId)
      await expectK12Composer()

      await wrapper.get('.hc-chat__research-btn').trigger('click')
      await flushPromises()
      expect(store.chatMode).toBe('research')
      expect(store.thinkingEnabled).toBe(true)
      expect(store.agentRole).toBe(k12AgentId)
      await expectK12Composer()

      await setChatDraft(wrapper, '请讲解二分之一加三分之一')
      await wrapper.get('.hc-composer__send').trigger('click')
      await vi.waitFor(() => {
        expect(
          store.messages.some(
            (message) =>
              message.role === 'user' && message.content === '请讲解二分之一加三分之一',
          ),
        ).toBe(true)
      })
      await vi.waitFor(() => {
        expect(store.sending).toBe(false)
      })
      await expectK12Composer()

      await store.selectSession(ordinarySessionId)
      await flushPromises()
      expect(store.agentRole).toBe('')
      expect(wrapper.findAll('[data-testid="composer-preset-chip"]')).toHaveLength(0)

      await store.selectSession(k12SessionId)
      await flushPromises()
      expect(store.agentRole).toBe(k12AgentId)
      expect(store.chatMode).toBe('research')
      expect(store.thinkingEnabled).toBe(true)
      await expectK12Composer()
    } finally {
      wrapper.unmount()
      clearSessionAgent(k12SessionId)
      clearSessionDeepThinking(k12SessionId)
      scenarioRegistry.reset()
    }
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

    await setChatDraft(wrapper, '立即发送')
    await wrapper.find('.hc-composer__send').trigger('click')
    await flushPromises()

    // backendText 改为惰性 thunk（BUG-20260628：避免发送「卡一下才上屏」），sendOptions 始终带 backendText 函数
    expect(sendSpy).toHaveBeenCalledWith(
      '立即发送',
      undefined,
      expect.objectContaining({ backendText: expect.any(Function) }),
    )
  })
})
