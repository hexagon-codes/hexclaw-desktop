import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ContextBar from '../ContextBar.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('ContextBar', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('prefers live runtime providers over persisted draft providers', () => {
    const settingsStore = useSettingsStore()
    settingsStore.config = {
      llm: {
        providers: [
          {
            id: 'draft-openai',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
            selectedModelId: 'gpt-4o',
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'draft-openai',
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
    settingsStore.runtimeProviders = [
      {
        id: 'live-zhipu',
        backendKey: '智谱',
        name: '智谱',
        type: 'custom',
        enabled: true,
        apiKey: '',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-5', name: 'GLM-5', capabilities: ['text'] }],
        selectedModelId: 'glm-5',
      },
    ]

    const appStore = useAppStore()
    appStore.sidecarReady = true
    const chatStore = useChatStore()
    chatStore.agentRole = ''

    const wrapper = mount(ContextBar, {
      global: {
        plugins: [createTestI18n(), pinia],
      },
    })

    expect(wrapper.text()).toContain('GLM-5')
    expect(wrapper.text()).not.toContain('GPT-4o')
  })
})
