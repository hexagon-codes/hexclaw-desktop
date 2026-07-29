/**
 * BUG-20260709 复现锁：用户发送到对话框的图片**点击放大无反应**。
 *
 * 症状：用户气泡附件图 CSS 带 cursor: zoom-in（.hc-msg__attachment-img 全局样式），
 * 视觉上承诺可放大，但该 <img> 没绑 @click=openImagePreview —— 点击无任何反应。
 * 助手气泡的同类图片有绑定（对照用例守住不被修坏）。
 *
 * 同构位置穷举（粒度匹配纪律）：`hc-msg__attachment-img` 全仓仅 2 处渲染
 * （assistant 有 click / user 缺 click）；编辑态缩略图 .hc-msg__edit-att-img 类名不同、
 * 无 zoom-in 语义，白名单豁免。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ChatView from '../ChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import type { ChatMessage } from '@/types'

const IMG_DATA = 'data:image/png;base64,Zm9vYmFy'

const { mockGetOllamaStatus } = vi.hoisted(() => ({
  mockGetOllamaStatus: vi.fn(),
}))

const { mockRoute, mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRoute: { query: {} as Record<string, string>, path: '/chat', params: {} as Record<string, string> },
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

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
  getAgents: vi.fn().mockResolvedValue({ agents: [], default: '' }),
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

function buildConfig() {
  return {
    llm: {
      defaultModel: 'model-default',
      defaultProviderId: 'p-default',
      providers: [
        {
          id: 'p-default', name: '默认厂商', type: 'openai', backendKey: 'defaultprov',
          enabled: true, apiKey: 'k', baseUrl: '',
          models: [{ id: 'model-default', name: 'Default Model' }],
          selectedModelId: 'model-default',
        },
      ],
    },
    security: {
      gateway_enabled: true, injection_detection: true, pii_filter: false,
      content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60,
    },
    general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
    notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
    mcp: { default_protocol: 'stdio' },
  }
}

function imageMsg(id: string, role: 'user' | 'assistant'): ChatMessage {
  return {
    id, role, content: '看这张图',
    timestamp: '2026-07-09T10:00:00Z',
    metadata: {
      attachments: [{ type: 'image', name: 'homework.png', mime: 'image/png', data: IMG_DATA }],
    },
  } as unknown as ChatMessage
}

async function mountWithMessages() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const settingsStore = useSettingsStore()
  settingsStore.config = buildConfig() as unknown as typeof settingsStore.config
  const wrapper = mount(ChatView, {
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
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
  chatStore.currentSessionId = 's-img'
  chatStore.messages = [imageMsg('u1', 'user'), imageMsg('a1', 'assistant')]
  await flushPromises()
  return wrapper
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

describe('BUG-20260709 用户发送的图片点击放大无反应', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(globalThis as Record<string, unknown>).isTauri = true
    localStorage.clear()
    mockRoute.query = {}
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0, models: [] })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('★用户气泡的附件图点击 → 必须打开图片预览 modal（CSS zoom-in 已承诺可放大）', async () => {
    const w = await mountWithMessages()
    const userImg = w.find('.hc-msg__bubble--user .hc-msg__attachment-img')
    expect(userImg.exists(), '前置：用户气泡渲染了附件图').toBe(true)
    await userImg.trigger('click')
    await flushPromises()
    const backdrop = w.find('.hc-img-preview__backdrop')
    expect(backdrop.exists(), '点击用户图片应打开预览 modal（当前无 click 绑定=点了没反应）').toBe(true)
    expect(w.find('.hc-img-preview__img').attributes('src')).toBe(IMG_DATA)
  })

  it('对照：助手气泡的附件图点击放大正常（修复不得破坏既有路径）', async () => {
    const w = await mountWithMessages()
    const aiImg = w.find('.hc-msg__bubble--assistant .hc-msg__attachment-img')
    expect(aiImg.exists(), '前置：助手气泡渲染了附件图').toBe(true)
    await aiImg.trigger('click')
    await flushPromises()
    expect(w.find('.hc-img-preview__backdrop').exists()).toBe(true)
  })

  it('预览打开后点击背板关闭（放大→收起闭环）', async () => {
    const w = await mountWithMessages()
    await w.find('.hc-msg__bubble--assistant .hc-msg__attachment-img').trigger('click')
    await flushPromises()
    await w.find('.hc-img-preview__backdrop').trigger('click')
    await flushPromises()
    expect(w.find('.hc-img-preview__backdrop').exists()).toBe(false)
  })
})
