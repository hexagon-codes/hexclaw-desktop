import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: {
    query: {} as Record<string, string>,
    path: '/chat',
    params: {} as Record<string, string>,
  },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
  sendChat: vi.fn(),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  appendSessionMessage: vi.fn().mockResolvedValue({ id: 'm1', session_id: 's1' }),
  appendSessionMessagesBatch: vi.fn().mockResolvedValue({ ids: [], session_id: 's1' }),
}))
vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: vi.fn().mockReturnValue(false),
    connect: vi.fn().mockRejectedValue(new Error('test')),
    clearCallbacks: vi.fn(),
    clearStreamCallbacks: vi.fn(),
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
  getOllamaStatus: vi
    .fn()
    .mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] }),
}))
vi.mock('@/api/im-channels', () => ({
  getConnections: vi.fn().mockResolvedValue([]),
  getConnectionsResult: vi.fn().mockResolvedValue({ connections: [] }),
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
    async get() {
      return null
    }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  return Object.fromEntries(Object.keys(original).map((key) => [key, stub]))
})
vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => mockRoute),
  useRouter: vi.fn(() => ({ push: mockRouterPush, replace: mockRouterReplace })),
}))

const streamingReasoning = ref('')
const streamingContent = ref('')

function setupStreaming(reasoning: string, content = '') {
  const store = useChatStore()
  streamingReasoning.value = reasoning
  streamingContent.value = content
  Object.defineProperty(store, 'isCurrentStreaming', { configurable: true, get: () => true })
  Object.defineProperty(store, 'isCurrentStreamingReasoning', {
    configurable: true,
    get: () => streamingReasoning.value,
  })
  Object.defineProperty(store, 'isCurrentStreamingContent', {
    configurable: true,
    get: () => streamingContent.value,
  })
  store.currentSessionId = 'reasoning-session'
  store.messages.push({ id: 'u1', role: 'user', content: '516−356=', timestamp: '' })
}

function mountChatView(setup?: () => void) {
  const pinia = createPinia()
  setActivePinia(pinia)
  setup?.()
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
  return mount(ChatView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        SessionList: { template: '<div />' },
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
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('BUG-20260724: Main Chat reasoning uses the safe Markdown renderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamingReasoning.value = ''
    streamingContent.value = ''
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

  it('renders persisted/history reasoning Markdown without raw markers', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    useChatStore().messages.push({
      id: 'a1',
      role: 'assistant',
      content: '160',
      reasoning: '**Planning concise arithmetic explanation**',
      timestamp: '',
    })
    await flushPromises()

    const reasoning = wrapper.get('.hc-thinking__content')
    expect(reasoning.get('strong').text()).toBe('Planning concise arithmetic explanation')
    expect(reasoning.text()).not.toContain('**')
    wrapper.unmount()
  })

  it('renders reasoning-only streaming Markdown without raw markers', async () => {
    const wrapper = mountChatView(() =>
      setupStreaming('**Planning concise arithmetic explanation**'),
    )
    await flushPromises()

    const reasoning = wrapper.get('.hc-thinking__content')
    expect(reasoning.get('strong').text()).toBe('Planning concise arithmetic explanation')
    expect(reasoning.text()).not.toContain('**')
    wrapper.unmount()
  })

  it('renders reasoning+content streaming Markdown without raw markers', async () => {
    const wrapper = mountChatView(() =>
      setupStreaming('**Planning concise arithmetic explanation**', '516 − 356 = 160'),
    )
    await flushPromises()

    const reasoning = wrapper.get('.hc-thinking__content')
    expect(reasoning.get('strong').text()).toBe('Planning concise arithmetic explanation')
    expect(reasoning.text()).not.toContain('**')
    wrapper.unmount()
  })

  it('sanitizes reasoning HTML/unsafe links and never creates artifact previews', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    useChatStore().messages.push({
      id: 'a-sec',
      role: 'assistant',
      content: 'safe',
      reasoning: [
        '**safe**',
        '<script data-reasoning-xss>alert(1)</script>',
        '<img src=x onerror="alert(2)">',
        '[unsafe](javascript:alert(3))',
        '```html',
        '<button onclick="alert(4)">run</button>',
        '```',
      ].join('\n'),
      timestamp: '',
    })
    await flushPromises()

    const reasoning = wrapper.get('.hc-thinking__content')
    expect(reasoning.get('strong').text()).toBe('safe')
    expect(reasoning.find('script').exists()).toBe(false)
    expect(reasoning.find('[onerror]').exists()).toBe(false)
    expect(reasoning.find('[onclick]').exists()).toBe(false)
    expect(reasoning.find('a[href^="javascript:"]').exists()).toBe(false)
    expect(reasoning.find('.artifact-renderer').exists()).toBe(false)
    expect(reasoning.text()).not.toContain('Preview')
    wrapper.unmount()
  })
})
