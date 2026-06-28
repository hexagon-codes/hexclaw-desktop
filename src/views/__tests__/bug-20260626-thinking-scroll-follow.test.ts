import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import { useChatStore } from '@/stores/chat'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * BUG-20260626：模型「思考中」流式输出推理文本时，用户无法在思考框里向上滚动看前面的内容。
 *
 * 根因：streaming reasoning 的 watcher（watch isCurrentStreamingReasoning）每来一个 chunk 就
 *   **无条件** 执行 `thinkingContentRef.scrollTop = thinkingContentRef.scrollHeight`，把这个
 *   `max-height:40vh; overflow-y:auto` 的独立滚动框死拽到底——用户刚上滚一点，下一个 chunk 立刻拽回，
 *   于是「往上滚看不了上面的思考内容」。
 *
 * 不变量（对齐主消息容器 shouldAutoScroll 的「贴底才跟随」语义）：
 *   仅当用户**已贴近思考框底部**时才自动跟随；用户上滚阅读时不得抢夺滚动条。
 *
 * 驱动方式：reasoning/content 流式态由 chat store 深度封装（无公开 setter），故在挂载前用受控
 * reactive ref 覆写三个流式 computed 的 getter——这样 ChatView 的 watcher 会追踪本 ref，
 * 改动它即真实触发组件里那段「思考框跟随」逻辑。几何由 WebKit 真机手感门另行取证。
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

function mountChatView(setup?: () => void) {
  const pinia = createPinia()
  setActivePinia(pinia)
  setup?.()
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

/** 实时思考框 = `.hc-thinking__header + .hc-thinking__content`（max-height:40vh; overflow-y:auto）。 */
function liveThinkingBox(wrapper: ReturnType<typeof mountChatView>): HTMLElement | null {
  return wrapper.element.querySelector('.hc-thinking__header + .hc-thinking__content')
}

// 受控流式态：用 reactive ref 喂三个 computed getter，挂载前覆写到 store 上。
const reasoningRef = ref('')
const contentRef = ref('')

function setupStreamingReasoning(initial: string) {
  const store = useChatStore()
  reasoningRef.value = initial
  contentRef.value = ''
  Object.defineProperty(store, 'isCurrentStreaming', { configurable: true, get: () => true })
  Object.defineProperty(store, 'isCurrentStreamingContent', { configurable: true, get: () => contentRef.value })
  Object.defineProperty(store, 'isCurrentStreamingReasoning', { configurable: true, get: () => reasoningRef.value })
  store.currentSessionId = 'think-session'
  store.messages.push({ id: 'u1', role: 'user', content: '问题', timestamp: '' })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  })
})

describe('BUG-20260626: 思考流式时不得把思考框从用户上滚处拽回底部', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reasoningRef.value = ''
    contentRef.value = ''
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

  it('用户在思考框里上滚后，新到的 reasoning chunk 不得把它拽回底部（核心 bug）', async () => {
    const wrapper = mountChatView(() => setupStreamingReasoning('思考第一行\n思考第二行\n思考第三行'))
    await flushPromises()

    const box = liveThinkingBox(wrapper)
    expect(box, '实时思考框应已渲染').toBeTruthy()

    // 用户上滚：停在 scrollTop=100，距底 1000-100-200=700px（远离底部）
    setGeometry(box!, { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 })

    // 又来一个 reasoning chunk → 触发 watcher
    reasoningRef.value += '\n刚刚追加的一段新思考'
    await flushPromises()

    // 不变量：scrollTop 仍停在用户上滚处（100），绝不被拽到 scrollHeight(1000)
    expect(box!.scrollTop).toBe(100)
  })

  it('用户停在思考框底部时，新 chunk 仍正常跟随贴底（不因修复而失去自动跟随）', async () => {
    const wrapper = mountChatView(() => setupStreamingReasoning('思考第一行\n思考第二行'))
    await flushPromises()

    const box = liveThinkingBox(wrapper)
    expect(box).toBeTruthy()

    // 用户贴底：scrollTop=790，距底 1000-790-200=10px（视作已在底部）
    setGeometry(box!, { scrollHeight: 1000, clientHeight: 200, scrollTop: 790 })

    reasoningRef.value += '\n继续思考'
    await flushPromises()

    // 贴底态应继续跟随到最新底部
    expect(box!.scrollTop).toBe(1000)
  })
})
