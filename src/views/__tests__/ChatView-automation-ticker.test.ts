/**
 * ChatView automation progress card — 1Hz elapsed ticker.
 *
 * Review gaps covered:
 *   - ticker updates the elapsed label every second and is cleared on unmount
 *   - elapsed label formats mm:ss past 60s (L4: "183s" → "3:03")
 *   - hint priority: action.progress?.message wins over t('chat.cronCompileHint')
 *   - window focus listener is removed on unmount (backlog leak fix)
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import { CHAT_AUTOMATION_METADATA_KEY } from '@/utils/chat-automation'

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {}, path: '/chat', params: {} as Record<string, string> },
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
  getOllamaStatus: vi.fn().mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] }),
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

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

function mountChatView() {
  const pinia = createPinia()
  setActivePinia(pinia)
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

function pushRunningCreateTaskAction(progress?: { stage: string; message: string }) {
  const store = useChatStore()
  store.messages.push(
    { id: 'u1', role: 'user', content: '每天9点生成日报', timestamp: '2026-06-11T00:00:00Z' },
    {
      id: 'a1',
      role: 'assistant',
      content: '好的，正在创建任务',
      timestamp: '2026-06-11T00:00:01Z',
      metadata: {
        [CHAT_AUTOMATION_METADATA_KEY]: [
          {
            id: 'act-1',
            kind: 'create_task',
            title: '创建定时任务',
            description: '每天9点生成日报',
            status: 'running',
            startedAt: Date.now(),
            payload: { name: '日报', schedule: '0 9 * * *', prompt: '生成日报' },
            ...(progress ? { progress } : {}),
          },
        ],
      },
    },
  )
  return store
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

describe('ChatView automation 1Hz elapsed ticker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the elapsed label and advances it every second', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    pushRunningCreateTaskAction()
    await flushPromises()

    const progressEl = wrapper.find('[data-testid="automation-progress"]')
    expect(progressEl.exists()).toBe(true)
    const elapsed = () => wrapper.find('.hc-msg__automation-progress-elapsed')
    expect(elapsed().text()).toBe('0s')

    await vi.advanceTimersByTimeAsync(3000)
    expect(elapsed().text()).toBe('3s')

    wrapper.unmount()
  })

  it('formats mm:ss past 60 seconds (L4: 183s → 3:03)', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    pushRunningCreateTaskAction()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(183_000)
    expect(wrapper.find('.hc-msg__automation-progress-elapsed').text()).toBe('3:03')

    wrapper.unmount()
  })

  it('hint shows progress.message when present, falls back to chat.cronCompileHint', async () => {
    const wrapper = mountChatView()
    await flushPromises()
    const store = pushRunningCreateTaskAction()
    await flushPromises()

    // No progress yet → localized fallback hint.
    expect(wrapper.find('.hc-msg__automation-progress-hint').text()).toBe('正在编译，无需重复点击')

    // Server progress message takes priority over the static hint.
    const action = (store.messages[1]!.metadata![CHAT_AUTOMATION_METADATA_KEY] as Record<string, unknown>[])[0]!
    action.progress = { stage: 'calling_llm', message: '自动纠错重试 2/3' }
    await flushPromises()
    expect(wrapper.find('.hc-msg__automation-progress-hint').text()).toBe('自动纠错重试 2/3')

    wrapper.unmount()
  })

  it('clears the interval and removes the focus listener on unmount', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const wrapper = mountChatView()
    await flushPromises()
    pushRunningCreateTaskAction()
    await flushPromises()

    const timersBefore = vi.getTimerCount()
    expect(timersBefore).toBeGreaterThan(0)

    wrapper.unmount()

    // The 1Hz ticker interval must be gone — advancing time after unmount
    // would otherwise keep mutating reactive state of a dead component.
    expect(vi.getTimerCount()).toBeLessThan(timersBefore)
    // Backlog fix: the window focus probe must be detached.
    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function))
  })
})
