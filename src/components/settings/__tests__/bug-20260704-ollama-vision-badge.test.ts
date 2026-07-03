import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import OllamaCard from '../OllamaCard.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * BUG-20260704：本地视觉模型（qwen3.5:9b）在「本地模型 (Ollama)」面板只显示「文本」，
 * 不显示「视觉」。根因：徽章按模型名查静态表 resolveOllamaCapabilities(name) 猜能力，
 * qwen3.5:9b 不在表里 → 只回退 ['text']；而 Ollama /api/tags 明明真实上报了
 * capabilities: ['completion','vision','tools','thinking']。
 *
 * 契约：徽章优先用后端/Ollama 上报的真实 capabilities，视觉模型显示「视觉」徽章。
 */

const getOllamaStatus = vi.hoisted(() => vi.fn())
const getOllamaRunning = vi.hoisted(() => vi.fn())
const syncOllamaModels = vi.hoisted(() => vi.fn())
const settingsStore = {
  config: { llm: { providers: [{ id: 'ollama-1', type: 'ollama', enabled: true }] } },
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
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => settingsStore }))
vi.mock('vue-router', () => ({ useRouter: vi.fn().mockReturnValue({ push: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function mountCard() {
  return mount(OllamaCard, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })],
    },
  })
}

describe('BUG-20260704 Ollama 视觉能力徽章', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOllamaRunning.mockResolvedValue([])
    settingsStore.config.llm.providers = [{ id: 'ollama-1', type: 'ollama', enabled: true }]
  })

  it('视觉模型（capabilities 含 vision）显示「视觉」徽章，即使模型名不在静态表', async () => {
    getOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [
        {
          name: 'qwen3.5:9b',
          size: 6600000000,
          modified: '2026-07-01T00:00:00Z',
          parameter_size: '9B',
          // Ollama /api/tags 真实上报（此前后端漏读、前端只按名猜）
          capabilities: ['completion', 'vision', 'tools', 'thinking'],
        },
      ],
    })

    const wrapper = mountCard()
    await flushPromises()

    const caps = wrapper.findAll('.ollama-card__cap').map((c) => c.text())
    // 核心：必须出现「视觉」徽章（此前只有「文本」= bug）。
    expect(caps.join(' '), `徽章实际=${JSON.stringify(caps)}`).toContain('视觉')
    // 文本也应保留（视觉模型 = 文本 + 视觉）。
    expect(caps.join(' ')).toContain('文本')
  })

  it('纯文本模型（capabilities 无 vision）不显示「视觉」', async () => {
    getOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [
        {
          name: 'some-text-model:7b',
          size: 4000000000,
          modified: '2026-07-01T00:00:00Z',
          capabilities: ['completion', 'tools'],
        },
      ],
    })

    const wrapper = mountCard()
    await flushPromises()

    const caps = wrapper.findAll('.ollama-card__cap').map((c) => c.text())
    expect(caps.join(' ')).toContain('文本')
    expect(caps.join(' ')).not.toContain('视觉')
  })

  it('无 capabilities 上报（旧版 Ollama）→ 回退静态表，不炸', async () => {
    getOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5000000000, modified: '2026-07-01T00:00:00Z' }],
    })

    const wrapper = mountCard()
    await flushPromises()

    // 至少渲染出徽章（静态表兜底），不因缺 capabilities 报错。
    expect(wrapper.findAll('.ollama-card__cap').length).toBeGreaterThan(0)
  })
})
