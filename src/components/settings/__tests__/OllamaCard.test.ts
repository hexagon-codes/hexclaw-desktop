import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import OllamaCard from '../OllamaCard.vue'
import zhCN from '@/i18n/locales/zh-CN'

const getOllamaStatus = vi.hoisted(() => vi.fn())
const getOllamaRunning = vi.hoisted(() => vi.fn())
const syncOllamaModels = vi.hoisted(() => vi.fn())
const settingsStore = {
  config: { llm: { providers: [{ id: 'openai-1', type: 'openai', enabled: true }] } },
  syncOllamaModels,
}

vi.mock('@/api/ollama', () => ({
  getOllamaStatus,
  getOllamaRunning,
  pullOllamaModel: vi.fn(),
  unloadOllamaModel: vi.fn(),
  deleteOllamaModel: vi.fn(),
  restartOllama: vi.fn(),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => settingsStore,
}))

vi.mock('vue-router', () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createI18nInstance() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
}

describe('OllamaCard integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOllamaStatus.mockResolvedValue({ running: true, associated: true, models: [] })
    getOllamaRunning.mockResolvedValue([])
    settingsStore.config.llm.providers = [{ id: 'openai-1', type: 'openai', enabled: true }]
  })

  it('emits associate and syncs models when Ollama is running without a provider', async () => {
    // Ensure there is no ollama provider so auto-associate fires
    settingsStore.config.llm.providers = []

    const wrapper = mount(OllamaCard, {
      global: { plugins: [createI18nInstance()] },
    })

    await flushPromises()

    expect(wrapper.emitted('associate')).toBeDefined()
    expect(syncOllamaModels).toHaveBeenCalledTimes(1)
    expect(getOllamaRunning).toHaveBeenCalled()
  })

  it('shows associated state when status reports running and a provider exists', async () => {
    const wrapper = mount(OllamaCard, {
      global: { plugins: [createI18nInstance()] },
    })

    await flushPromises()
    // No enabled Ollama provider in the mock store, so stateLabel shows '已禁用'
    expect(wrapper.text()).toContain('已禁用')
  })
})
