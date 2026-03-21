import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'

// ─── Mock API 模块 ──────────────────────────────────────
vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: '你好！', session_id: 's1' }),
  sendChat: vi.fn(),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: vi.fn().mockReturnValue(false),
    connect: vi.fn().mockRejectedValue(new Error('test')),
    clearCallbacks: vi.fn(),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onReply: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn(),
  },
}))

vi.mock('@/db/chat', () => ({
  dbGetSessions: vi.fn().mockResolvedValue([]),
  dbCreateSession: vi.fn().mockResolvedValue(undefined),
  dbUpdateSessionTitle: vi.fn().mockResolvedValue(undefined),
  dbTouchSession: vi.fn().mockResolvedValue(undefined),
  dbDeleteSession: vi.fn().mockResolvedValue(undefined),
  dbGetMessages: vi.fn().mockResolvedValue([]),
  dbSaveMessage: vi.fn().mockResolvedValue(undefined),
  dbDeleteMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
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

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
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
  useRoute: vi.fn().mockReturnValue({ query: {}, path: '/chat', params: {} }),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn(), replace: vi.fn() }),
}))

/**
 * 挂载 ChatView 的辅助函数
 */
function mountChatView() {
  const pinia = createPinia()
  setActivePinia(pinia)
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

    // 输入消息
    const textarea = wrapper.find('textarea')
    await textarea.setValue('测试消息')

    // 按 Enter 发送（模拟 ChatInput 的 @send 事件）
    const chatInput = wrapper.findComponent({ name: 'ChatInput' })
    if (chatInput.exists()) {
      chatInput.vm.$emit('send', '测试消息')
    } else {
      // 直接触发 keydown
      await textarea.trigger('keydown', { key: 'Enter', shiftKey: false })
    }
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
    store.streaming = true
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

    store.streaming = true
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
})
