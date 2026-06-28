import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * BUG-20260626（截图2）：打开既有会话、视口已自动停在最底（下面无内容）时，
 * 「滚动到底部」下翻箭头仍残留显示。
 *
 * 根因：showScrollToBottom/showScrollToTop 只在 @scroll 事件里经 scrollNavFlags 重算。
 * 打开会话时平滑滚到底的动画中途会触发若干 scroll 事件（此刻几何仍"已上滚"→置 true），
 * 而当头像图片 / markdown 异步加载导致内容重排后，并不会再触发 scroll 事件去把标记纠正回
 * 真实底部几何 → 箭头卡在 true（截图：默认打开即显，下方实无内容）。
 *
 * 修复两道闸（均在 ChatView）：
 *  ① scrollToBottom 真正滚到底后，权威清空 showScrollToBottom/showScrollToTop（既然已对齐最底，
 *     "跳到底部"的可视提示一定无意义）；
 *  ② ResizeObserver 监听消息容器尺寸变化（图片/markdown 重排）→ 重算几何，并在"跟随态"下重新贴底，
 *     不再依赖一定会到来的终态 scroll 事件。
 */

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {} as Record<string, string>, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
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
    sendMessage: vi.fn(), sendRaw: vi.fn(), triggerError: vi.fn(), sendApprovalResponse: vi.fn(),
  },
}))
vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
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
    default: 'openai', providers: {},
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  updateLLMConfig: vi.fn(),
}))
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: vi.fn().mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] }),
}))
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/utils/file-parser', () => ({
  parseDocument: vi.fn().mockResolvedValue({ text: '', fileName: '', pageCount: 0 }),
  isDocumentFile: vi.fn().mockReturnValue(false),
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

function createTestI18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountChatView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createTestI18n()
  return mount(ChatView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        SessionList: { template: '<div data-testid="session-list" />' },
        MarkdownRenderer: { props: ['content'], template: '<div class="markdown-stub">{{ content }}</div>' },
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

/** 给 jsdom 元素打上可控的滚动几何（jsdom 默认全 0、无布局）。 */
function setGeometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: g.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: g.clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: g.scrollTop })
}

// 捕获 ChatView 在 onMounted 里创建的 ResizeObserver 回调，便于手动驱动"内容重排"。
let capturedResizeCb: (() => void) | null = null

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(cb: () => void) { capturedResizeCb = cb }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  })
})

describe('BUG-20260626: 打开会话默认在底部时不残留下翻箭头', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedResizeCb = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    mockRoute.query = {}
    mockRoute.path = '/chat'
    mockRoute.params = {}
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('①程序性滚到底后，必须清掉残留的下翻箭头（force 滚动是打开会话/发消息的共同路径）', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push(
      { id: 'u1', role: 'user', content: '问题', timestamp: '' },
      { id: 'a1', role: 'assistant', content: '回答', timestamp: '' },
    )
    await flushPromises()
    await new Promise((r) => setTimeout(r, 130)) // 排空 messages watch 触发的 100ms 节流定时器

    const vm = wrapper.vm as unknown as {
      messagesContainerRef: HTMLElement
      showScrollToBottom: boolean
      scrollToBottom: (force?: boolean) => void
    }
    const el = vm.messagesContainerRef
    // 模拟"长会话当前停在顶部"——加载动画中途的残留几何
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    await wrapper.find('.hc-chat__messages').trigger('scroll')
    expect(vm.showScrollToBottom).toBe(true) // 前置：箭头被置 true

    // 程序性滚到底（打开会话 watch / 发送消息都会走这条）。滚到底后 = 底部对齐 = 不应再有下翻箭头。
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 }) // 滚到底
    vm.scrollToBottom(true)
    await new Promise((r) => setTimeout(r, 130)) // 越过 100ms 节流
    await flushPromises()

    expect(vm.showScrollToBottom).toBe(false)
  })

  it('④结构契约：箭头渲染在 .hc-chat__input-area 内（ChatGPT 风格悬于输入框上方的锚点不被改回）', async () => {
    // 运行时几何（输入框上方 12px 居中）已用真实浏览器 Chromium 取证（playwright 实测 delta=0/gap≈12）；
    // 此处在 CI 锁住其结构前提：箭头必须是 .hc-chat__input-area 的后代（CSS bottom:calc(100%+12px) 才有意义）。
    // 若有人把按钮挪回消息区（旧 .hc-chat__main 锚点），本断言立即 RED。
    const wrapper = mountChatView()
    await flushPromises()
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push(
      { id: 'u1', role: 'user', content: '问题', timestamp: '' },
      { id: 'a1', role: 'assistant', content: '回答', timestamp: '' },
    )
    await flushPromises()
    await new Promise((r) => setTimeout(r, 130))

    const vm = wrapper.vm as unknown as { messagesContainerRef: HTMLElement; showScrollToBottom: boolean }
    const el = vm.messagesContainerRef
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    await wrapper.find('.hc-chat__messages').trigger('scroll')
    expect(vm.showScrollToBottom).toBe(true)
    await flushPromises()

    // 下翻箭头必须是输入区的后代（锚点 = .hc-chat__input-area，position:relative）
    expect(wrapper.find('.hc-chat__input-area .hc-chat__scroll-btn--bottom').exists()).toBe(true)
    // 反向：不得再挂在消息容器/主区直接子层（旧锚点）——输入区内能找到即证明已迁移
    const btnInMessages = wrapper.find('.hc-chat__messages .hc-chat__scroll-btn--bottom').exists()
    expect(btnInMessages).toBe(false)
  })

  it('③点下翻箭头(force)不被挂起的非 force 节流定时器吞掉——点击必生效', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push(
      { id: 'u1', role: 'user', content: '问题', timestamp: '' },
      { id: 'a1', role: 'assistant', content: '回答', timestamp: '' },
    )
    await flushPromises()
    await new Promise((r) => setTimeout(r, 130)) // 排空 messages watch 的节流定时器

    const vm = wrapper.vm as unknown as {
      messagesContainerRef: HTMLElement
      showScrollToBottom: boolean
      scrollToBottom: (force?: boolean) => void
    }
    const el = vm.messagesContainerRef
    // 1) 底部跟随态：发一次非 force scrollToBottom 占住 100ms 节流窗口（闭包里 force=false）
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 })
    vm.scrollToBottom(false)
    // 2) 用户在窗口内快速上滚 → 标记已上滚 + 显示下翻箭头
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    await wrapper.find('.hc-chat__messages').trigger('scroll')
    expect(vm.showScrollToBottom).toBe(true)
    // 3) 用户点下翻箭头（force=true）——此刻非 force 定时器仍挂起。force 必须抢占，不能被吞。
    vm.scrollToBottom(true)
    await new Promise((r) => setTimeout(r, 140))
    await flushPromises()

    expect(vm.showScrollToBottom).toBe(false)
  })

  it('②内容重排（图片/markdown 异步加载）后，已在底部则下翻箭头隐藏（ResizeObserver 重算）', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.messages.push(
      { id: 'u1', role: 'user', content: '问题', timestamp: '' },
      { id: 'a1', role: 'assistant', content: '回答', timestamp: '' },
    )
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      messagesContainerRef: HTMLElement
      showScrollToBottom: boolean
    }
    const el = vm.messagesContainerRef
    // 残留 true：一条中途 scroll 把箭头置真
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 })
    await wrapper.find('.hc-chat__messages').trigger('scroll')
    expect(vm.showScrollToBottom).toBe(true)

    // 重排后其实已贴底（distanceFromBottom≈0）。ResizeObserver 应重算并隐藏箭头。
    setGeometry(el, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 })
    expect(capturedResizeCb).toBeTypeOf('function')
    capturedResizeCb?.()
    await flushPromises()

    expect(vm.showScrollToBottom).toBe(false)
  })
})
