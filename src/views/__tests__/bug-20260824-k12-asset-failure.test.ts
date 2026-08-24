import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { defaultConfig } from '@/stores/settings-defaults'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import type { ChatMessage } from '@/types'

const { mockK12GetAssetBlob, mockGetOllamaStatus } = vi.hoisted(() => ({
  mockK12GetAssetBlob: vi.fn(),
  mockGetOllamaStatus: vi.fn(),
}))

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
  appendSessionMessagesBatch: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/k12-asset-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/k12-asset-url')>()
  return {
    ...actual,
    k12GetAssetBlob: (...args: unknown[]) => mockK12GetAssetBlob(...args),
  }
})

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
  getAgents: vi.fn().mockResolvedValue({ agents: [], default: '' }),
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
    default: '',
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
  getConnections: vi.fn().mockResolvedValue([]),
  getConnectionsResult: vi.fn().mockResolvedValue({ connections: [] }),
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
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
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

vi.mock('markdown-it', () => ({
  default: vi.fn().mockImplementation(() => ({
    render: (source: string) => `<p>${source}</p>`,
    renderer: { rules: { fence: null } },
    utils: { escapeHtml: (source: string) => source },
  })),
}))

vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => mockRoute),
  useRouter: vi.fn(() => ({ push: mockRouterPush, replace: mockRouterReplace })),
}))

function failedAssetMessage(id: string, role: 'user' | 'assistant'): ChatMessage {
  return {
    id,
    role,
    content: role === 'assistant' ? '图片处理结果' : '',
    timestamp: '2026-08-24T00:00:00Z',
    metadata: {
      attachments: [
        {
          type: 'image',
          name: `${role}.png`,
          mime: 'image/png',
          data: `asset://k12-agent/${role}.png`,
        },
      ],
    },
  } as ChatMessage
}

async function mountWithFailedAssets() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useSettingsStore().config = defaultConfig()
  const wrapper = mount(ChatView, {
    global: {
      plugins: [
        pinia,
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          fallbackLocale: 'zh-CN',
          messages: { 'zh-CN': zhCN, zh: zhCN },
        }),
      ],
      stubs: {
        SessionList: { template: '<div />' },
        MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        MessageActions: { template: '<div />' },
        ChatSearchDialog: { template: '<div />' },
        ChatExportMenu: { template: '<div />' },
        ArtifactsPanel: { template: '<div />' },
        ContextMenu: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  const chatStore = useChatStore()
  chatStore.currentSessionId = 'asset-failure-session'
  chatStore.messages = [
    failedAssetMessage('failed-user-asset', 'user'),
    failedAssetMessage('failed-assistant-asset', 'assistant'),
  ]
  await vi.waitFor(() => expect(mockK12GetAssetBlob).toHaveBeenCalledTimes(2))
  await flushPromises()
  return wrapper
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('BUG-20260824 K12 认证图片读取失败', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    mockRoute.query = {}
    mockK12GetAssetBlob.mockResolvedValue(null)
    mockGetOllamaStatus.mockResolvedValue({
      running: false,
      associated: false,
      model_count: 0,
      models: [],
    })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
    vi.restoreAllMocks()
  })

  it('认证读取返回 null 后不渲染空 src 图片，也不保留下载或预览入口', async () => {
    const wrapper = await mountWithFailedAssets()

    expect(mockK12GetAssetBlob).toHaveBeenCalledWith(
      'k12-agent',
      'asset://k12-agent/user.png',
      expect.any(AbortSignal),
    )
    expect(mockK12GetAssetBlob).toHaveBeenCalledWith(
      'k12-agent',
      'asset://k12-agent/assistant.png',
      expect.any(AbortSignal),
    )
    expect
      .soft(
        wrapper.findAll('.hc-msg__attachment-img').map((image) => image.attributes('src') ?? ''),
      )
      .not.toContain('')
    expect.soft(wrapper.findAll('.hc-msg__attachment-img')).toHaveLength(0)
    expect.soft(wrapper.findAll('.hc-msg__media-download')).toHaveLength(0)
    expect.soft(wrapper.find('.hc-img-preview__backdrop').exists()).toBe(false)

    const vm = wrapper.vm as unknown as { editingMsgId: string | null }
    vm.editingMsgId = 'failed-user-asset'
    await flushPromises()
    expect.soft(wrapper.find('.hc-msg__edit-card').exists()).toBe(true)
    expect.soft(wrapper.findAll('.hc-msg__edit-att-img')).toHaveLength(0)

    wrapper.unmount()
  })
})
