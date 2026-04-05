import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import WelcomeView from '../WelcomeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const testLLMConnection = vi.hoisted(() => vi.fn())
const addProvider = vi.hoisted(() => vi.fn())
const saveConfig = vi.hoisted(() => vi.fn(async () => {}))
const loadConfig = vi.hoisted(() => vi.fn(async () => {}))
const routerPush = vi.hoisted(() => vi.fn())

vi.mock('@/api/config', () => ({
  testLLMConnection,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    config: {
      llm: { providers: [], defaultModel: '', defaultProviderId: '' },
      general: { welcomeCompleted: false, defaultAgentRole: '' },
    },
    loadConfig,
    addProvider,
    saveConfig,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: vi.fn().mockReturnValue({ push: routerPush }),
}))

vi.mock('@/config/providers', () => ({
  PROVIDER_PRESETS: {
    openai: { name: 'OpenAI', placeholder: 'sk-', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }] },
  },
}))

vi.mock('@/components/common/ProviderSelect.vue', () => ({
  default: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<select><option value="openai"></option></select>',
  },
}))

function createI18nInstance() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
}

describe('WelcomeView onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testLLMConnection.mockResolvedValue({ ok: true, message: 'ok' })
    addProvider.mockReturnValue({ id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', models: [] })
  })

  it('finishes wizard, persists provider, and navigates to chat', async () => {
    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [createI18nInstance()],
        stubs: { ProviderSelect: true },
      },
    })

    await flushPromises()

    const vm = wrapper.vm as unknown as { apiKey: string; customBaseUrl: string; model: string; connectionTesting: boolean; connectionResult: { ok: boolean } | null; nextStep: () => Promise<void>; skip: () => void; testConnection: () => Promise<void> }
    vm.apiKey = 'sk-test'
    vm.customBaseUrl = ''
    vm.model = 'gpt-4o'
    await vm.testConnection()

    await vm.nextStep()
    await vm.nextStep()
    await vm.nextStep()
    await flushPromises()

    expect(addProvider).toHaveBeenCalled()
    expect(saveConfig).toHaveBeenCalled()
    expect(testLLMConnection).toHaveBeenCalled()
  })

  it('allows a fresh connection test after the previous one settles', async () => {
    testLLMConnection.mockReset()
    let resolveFirst!: (value: { ok: boolean; message?: string }) => void

    testLLMConnection
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce({ ok: false, message: 'new failed' })

    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [createI18nInstance()],
        stubs: { ProviderSelect: true },
      },
    })

    await flushPromises()

    const vm = wrapper.vm as unknown as {
      apiKey: string
      model: string
      connectionResult: { ok: boolean; msg: string } | null
      testConnection: () => Promise<void>
      canProceedFromStep0: boolean
    }

    vm.apiKey = 'sk-old'
    vm.model = 'gpt-4o'
    void vm.testConnection()
    await flushPromises()

    resolveFirst({ ok: true, message: 'old success' })
    await flushPromises()

    expect(vm.connectionResult).toEqual({ ok: true, msg: 'old success' })
    expect(vm.canProceedFromStep0).toBe(true)

    vm.apiKey = 'sk-new'
    void vm.testConnection()
    await flushPromises()

    expect(vm.connectionResult).toEqual({ ok: false, msg: 'new failed' })
    expect(vm.canProceedFromStep0).toBe(false)
  })

  it('marks welcome as completed and navigates to chat when skipping', async () => {
    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [createI18nInstance()],
        stubs: { ProviderSelect: true },
      },
    })

    await flushPromises()

    const vm = wrapper.vm as unknown as { skip: () => Promise<void> }
    await vm.skip()
    await flushPromises()

    expect(loadConfig).not.toHaveBeenCalled()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect((saveConfig.mock.calls[0] as unknown[])?.[0] as Record<string, Record<string, unknown>>).toHaveProperty('general.welcomeCompleted', true)
    expect(routerPush).toHaveBeenCalledWith('/chat')
  })

  it('does not start a second connection test while the first one is still running', async () => {
    testLLMConnection.mockReset()
    let resolveConnection!: (value: { ok: boolean; message?: string }) => void
    testLLMConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnection = resolve
        }),
    )

    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [createI18nInstance()],
        stubs: { ProviderSelect: true },
      },
    })

    await flushPromises()

    const vm = wrapper.vm as unknown as {
      apiKey: string
      model: string
      testConnection: () => Promise<void>
    }

    vm.apiKey = 'sk-test'
    vm.model = 'gpt-4o'

    void vm.testConnection()
    await flushPromises()
    void vm.testConnection()
    await flushPromises()

    expect(testLLMConnection).toHaveBeenCalledTimes(1)

    resolveConnection({ ok: true, message: 'ok' })
    await flushPromises()
  })

  it('does not start a second skip flow while the first one is still saving', async () => {
    saveConfig.mockReset()
    let resolveSave!: () => void
    saveConfig.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
    )

    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [createI18nInstance()],
        stubs: { ProviderSelect: true },
      },
    })

    await flushPromises()

    const vm = wrapper.vm as unknown as { skip: () => Promise<void> }
    void vm.skip()
    await flushPromises()
    void vm.skip()
    await flushPromises()

    expect(saveConfig).toHaveBeenCalledTimes(1)

    resolveSave()
    await flushPromises()
  })
})
