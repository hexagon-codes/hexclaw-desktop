import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import QuickChatView from '../QuickChatView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import { sendChat } from '@/api/chat'

const { mockGetLLMConfig, mockListen, wsMock } = vi.hoisted(() => {
  let sidecarReadyHandler: (() => Promise<void> | void) | null = null
  let chunkHandler: ((payload: { content: string; done?: boolean }) => void) | null = null
  let replyHandler: ((payload: { content: string }) => void) | null = null
  let errorHandler: ((error: string) => void) | null = null
  return {
    mockGetLLMConfig: vi.fn(),
    mockListen: vi.fn(async (event: string, callback: () => Promise<void> | void) => {
      if (event === 'sidecar-ready') {
        sidecarReadyHandler = callback
      }
      return vi.fn()
    }),
    wsMock: {
      connect: vi.fn().mockResolvedValue(undefined),
      clearCallbacks: vi.fn(() => {
        chunkHandler = null
        replyHandler = null
        errorHandler = null
      }),
      clearStreamCallbacks: vi.fn(() => {
        chunkHandler = null
        replyHandler = null
        errorHandler = null
      }),
      onChunk: vi.fn((callback: (payload: { content: string; done?: boolean }) => void) => {
        chunkHandler = callback
        return vi.fn()
      }),
      onReply: vi.fn((callback: (payload: { content: string }) => void) => {
        replyHandler = callback
        return vi.fn()
      }),
      onError: vi.fn((callback: (error: string) => void) => {
        errorHandler = callback
        return vi.fn()
      }),
      isConnected: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn(),
      emitSidecarReady: async () => {
        await sidecarReadyHandler?.()
      },
      emitChunk: (payload: { content: string; done?: boolean }) => {
        chunkHandler?.(payload)
      },
      emitReply: (payload: { content: string }) => {
        replyHandler?.(payload)
      },
      emitError: (error: string) => {
        errorHandler?.(error)
      },
    },
  }
})

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, callback: () => Promise<void> | void) => mockListen(event, callback),
}))

vi.mock('@/api/chat', () => ({
  sendChat: vi.fn().mockResolvedValue({ reply: 'ok' }),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: wsMock,
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

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

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('QuickChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    ;(globalThis as Record<string, unknown>).isTauri = true
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('falls back to the new runtime default when available models change after sidecar-ready', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore()
    store.config = {
      llm: {
        providers: [
          {
            id: 'openai',
            backendKey: 'openai',
            name: 'openai',
            type: 'openai',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'openai',
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
    store.runtimeProviders = [
      {
        id: 'openai',
        backendKey: 'openai',
        name: 'openai',
        type: 'openai',
        enabled: true,
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
      },
    ]
    store.loadConfig = vi.fn(async ({ force } = {}) => {
      if (force) {
        store.config = {
          ...store.config!,
          llm: {
            providers: [
              {
                id: 'zhipu',
                backendKey: '智谱',
                name: '智谱',
                type: 'custom',
                enabled: true,
                apiKey: '',
                baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
              },
            ],
            defaultModel: 'glm-5',
            defaultProviderId: 'zhipu',
          },
        }
        store.runtimeProviders = [
          {
            id: 'zhipu',
            backendKey: '智谱',
            name: '智谱',
            type: 'custom',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
          },
        ]
      }
    })

    const wrapper = mount(QuickChatView, {
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        },
      },
    })

    await flushPromises()
    expect(wrapper.text()).toContain('gpt-4o')

    store.config = {
      ...store.config!,
      llm: {
        providers: [
          {
            id: 'zhipu',
            backendKey: '智谱',
            name: '智谱',
            type: 'custom',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'glm-5',
        defaultProviderId: 'zhipu',
      },
    }
    store.runtimeProviders = [
      {
        id: 'zhipu',
        backendKey: '智谱',
        name: '智谱',
        type: 'custom',
        enabled: true,
        apiKey: '',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
      },
    ]
    await wsMock.emitSidecarReady()
    await flushPromises()

    expect(wrapper.text()).toContain('glm-5')
  })

  it('retrying an older websocket error should keep newer errors intact', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore()
    store.config = {
      llm: {
        providers: [
          {
            id: 'openai',
            backendKey: 'openai',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'openai',
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
    store.runtimeProviders = store.config.llm.providers

    const wrapper = mount(QuickChatView, {
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        },
      },
    })
    await flushPromises()

    const textarea = wrapper.get('textarea')
    const sendButton = () => wrapper.findAll('button').at(-1)!

    await textarea.setValue('第一条')
    await sendButton().trigger('click')
    await flushPromises()
    wsMock.emitError('err-first')
    await flushPromises()

    await textarea.setValue('第二条')
    await sendButton().trigger('click')
    await flushPromises()
    wsMock.emitError('err-second')
    await flushPromises()

    expect(wrapper.text()).toContain('err-first')
    expect(wrapper.text()).toContain('err-second')

    const retryButtons = wrapper.findAll('button').filter((btn) => btn.text().includes('重试'))
    expect(retryButtons).toHaveLength(2)
    await retryButtons[0]!.trigger('click')
    await flushPromises()
    wsMock.emitReply({ content: 'retry success' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('err-first')
    expect(wrapper.text()).toContain('err-second')
    expect(wrapper.text()).toContain('retry success')
  })

  it('ignores stale websocket replies that arrive after the user stops generation', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore()
    store.config = {
      llm: {
        providers: [
          {
            id: 'openai',
            backendKey: 'openai',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'openai',
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
    store.runtimeProviders = store.config.llm.providers

    const wrapper = mount(QuickChatView, {
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        },
      },
    })
    await flushPromises()

    const textarea = wrapper.get('textarea')
    const sendButton = () => wrapper.findAll('button').at(-1)!

    await textarea.setValue('需要停止')
    await sendButton().trigger('click')
    await flushPromises()

    wsMock.emitChunk({ content: 'partial' })
    await flushPromises()

    const stopBtn = wrapper.find('button[title="停止生成"]')
    expect(stopBtn).toBeDefined()
    expect(stopBtn.exists()).toBe(true)
    await stopBtn.trigger('click')
    await flushPromises()

    wsMock.emitReply({ content: 'stale reply' })
    await flushPromises()

    expect(wrapper.text()).toContain('partial')
    expect(wrapper.text()).not.toContain('stale reply')
  })

  it('ignores stale websocket replies that arrive after the user clears the chat mid-stream', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore()
    store.config = {
      llm: {
        providers: [
          {
            id: 'openai',
            backendKey: 'openai',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'openai',
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
    store.runtimeProviders = store.config.llm.providers

    const wrapper = mount(QuickChatView, {
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        },
      },
    })
    await flushPromises()

    const textarea = wrapper.get('textarea')
    const sendButton = () => wrapper.findAll('button').at(-1)!

    await textarea.setValue('需要清空')
    await sendButton().trigger('click')
    await flushPromises()

    wsMock.emitChunk({ content: 'partial' })
    await flushPromises()

    const clearBtn = wrapper.find('button[title="清空聊天"]')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    await flushPromises()

    wsMock.emitReply({ content: 'stale reply' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('需要清空')
    expect(wrapper.text()).not.toContain('partial')
    expect(wrapper.text()).not.toContain('stale reply')
  })

  it('ignores stale HTTP replies that arrive after the user clears the chat', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore()
    store.config = {
      llm: {
        providers: [
          {
            id: 'openai',
            backendKey: 'openai',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'openai',
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
    store.runtimeProviders = store.config.llm.providers

    wsMock.connect.mockRejectedValueOnce(new Error('ws down'))

    let resolveHttp!: (value: { reply: string }) => void
    vi.mocked(sendChat).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHttp = resolve as typeof resolveHttp
        }),
    )

    const wrapper = mount(QuickChatView, {
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: {
          MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
        },
      },
    })
    await flushPromises()

    const textarea = wrapper.get('textarea')
    const sendButton = () => wrapper.findAll('button').at(-1)!

    await textarea.setValue('HTTP 请求')
    await sendButton().trigger('click')
    await flushPromises()

    const clearBtn = wrapper.find('button[title="清空聊天"]')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    await flushPromises()

    resolveHttp({ reply: 'stale http reply' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('HTTP 请求')
    expect(wrapper.text()).not.toContain('stale http reply')
  })
})
