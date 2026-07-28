import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const push = vi.fn()
const getStatus = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => getStatus(),
  pullOllamaModel: vi.fn(),
  getOllamaRunning: vi.fn().mockResolvedValue([]),
  getOllamaRunningResult: vi.fn().mockResolvedValue({ models: [], reachable: true }),
  loadOllamaModel: vi.fn(),
  unloadOllamaModel: vi.fn(),
  deleteOllamaModel: vi.fn(),
  restartOllama: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  return Object.fromEntries(Object.keys(original).map((key) => [key, stub]))
})

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountCard(models: Array<Record<string, unknown>>) {
  getStatus.mockResolvedValue({
    running: true,
    associated: true,
    model_count: models.length,
    models,
  })
  const component = (await import('../OllamaCard.vue')).default
  const wrapper = mount(component, {
    global: {
      plugins: [i18n()],
      stubs: { Transition: { template: '<div><slot /></div>' } },
    },
  })
  await flushPromises()
  return wrapper
}

function modelRow(wrapper: Awaited<ReturnType<typeof mountCard>>, name: string) {
  const row = wrapper.findAll('.ollama-card__model').find((candidate) => candidate.text().includes(name))
  if (!row) throw new Error(`missing model row ${name}`)
  return row
}

describe('BUG-20260728-009 pure embedding capability projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('shows only Embedding plus delete and no chat action for an authoritative embedding capability', async () => {
    const wrapper = await mountCard([
      { name: 'qwen3-embedding:8b', size: 4_700_000_000, capabilities: ['embedding'] },
      { name: 'qwen3.5:9b', size: 6_000_000_000, capabilities: ['completion'] },
    ])

    const embedding = modelRow(wrapper, 'qwen3-embedding:8b')
    expect(embedding.text()).toContain('Embedding')
    expect(embedding.text()).not.toContain('文本')
    expect(embedding.find('.ollama-card__model-btn--chat').exists()).toBe(false)
    expect(embedding.find('.ollama-card__model-btn--danger').exists()).toBe(true)

    const chat = modelRow(wrapper, 'qwen3.5:9b')
    expect(chat.text()).toContain('文本')
    expect(chat.find('.ollama-card__model-btn--chat').exists()).toBe(true)
  })

  it('recognizes an embedding-only model by the shared fallback when old Ollama omits capabilities', async () => {
    const wrapper = await mountCard([
      { name: 'qwen3-embedding:8b', size: 4_700_000_000 },
    ])

    const embedding = modelRow(wrapper, 'qwen3-embedding:8b')
    expect(embedding.text()).toContain('Embedding')
    expect(embedding.find('.ollama-card__model-btn--chat').exists()).toBe(false)
  })

  it('does not offer 去对话 after downloading a pure embedding model', async () => {
    const wrapper = await mountCard([])
    const vm = wrapper.vm as unknown as {
      pullStatus: string
      lastDownloaded: string
    }
    vm.pullStatus = '__pull_done__'
    vm.lastDownloaded = 'qwen3-embedding:8b'
    await flushPromises()

    expect(wrapper.find('.ollama-card__pull-go-chat').exists()).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })
})
