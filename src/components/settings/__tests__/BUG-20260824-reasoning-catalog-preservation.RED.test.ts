import { beforeEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ModelManagerModal from '../ModelManagerModal.vue'
import { useModelCatalogStore } from '@/stores/model-catalog'
import { useSettingsStore } from '@/stores/settings'
import { defaultConfig } from '@/stores/settings-defaults'
import zhCN from '@/i18n/locales/zh-CN'
import type { CatalogModel, ModelOption, ModelReasoningControl, ProviderConfig } from '@/types'

const REASONING_CONTROL: ModelReasoningControl = {
  dialect: 'reasoning_effort',
  on: 'high',
  off: 'none',
  allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}

const REASONING_MODEL: CatalogModel = {
  id: 'exact-reasoning-model',
  name: 'Exact Reasoning Model',
  reasoningSupport: 'supported',
  reasoningControl: REASONING_CONTROL,
}

function providerFixture(models: ModelOption[]): ProviderConfig {
  return {
    id: 'hexclaw-gpt',
    name: 'HexClaw GPT',
    type: 'custom',
    enabled: true,
    apiKey: 'masked-test-value',
    baseUrl: 'https://provider.invalid/v1',
    selectedModelId: 'stable-chat',
    models,
  }
}

function mountManager(provider: ProviderConfig, catalog: CatalogModel[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const settings = useSettingsStore()
  settings.config = defaultConfig()
  settings.config.llm.providers = [provider]
  settings.config.llm.defaultProviderId = provider.id
  settings.config.llm.defaultModel = provider.selectedModelId || ''
  useModelCatalogStore().setCatalog(provider.id, catalog)

  mount(ModelManagerModal, {
    props: { open: true, provider },
    global: {
      plugins: [
        pinia,
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          messages: { 'zh-CN': zhCN },
        }),
      ],
    },
  })

  return settings
}

function dialogBody() {
  return new DOMWrapper(document.body)
}

async function toggleModel(modelId: string) {
  await dialogBody().get(`[data-testid="model-manager-toggle-${modelId}"]`).trigger('click')
}

async function applyChanges() {
  await dialogBody().get('[data-testid="model-manager-apply"]').trigger('click')
  await flushPromises()
}

function expectExactReasoningContract(model: ModelOption | CatalogModel | undefined) {
  expect(model).toMatchObject({
    reasoningSupport: 'supported',
    reasoningControl: REASONING_CONTROL,
  })
}

describe('BUG-20260824 · dynamic catalog reasoning contract preservation', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('preserves exact reasoning fields when a catalog model is enabled for the first time', async () => {
    expect.hasAssertions()
    const provider = providerFixture([
      { id: 'stable-chat', name: 'Stable Chat', capabilities: ['text'] },
    ])
    const settings = mountManager(provider, [
      { id: 'stable-chat', name: 'Stable Chat' },
      REASONING_MODEL,
    ])

    await toggleModel(REASONING_MODEL.id)
    await applyChanges()

    expectExactReasoningContract(
      settings.config!.llm.providers[0]!.models.find((model) => model.id === REASONING_MODEL.id),
    )
  })

  it('preserves exact reasoning fields when an enabled model is disabled then re-enabled', async () => {
    expect.hasAssertions()
    const provider = providerFixture([
      { id: 'stable-chat', name: 'Stable Chat', capabilities: ['text'] },
      {
        id: REASONING_MODEL.id,
        name: REASONING_MODEL.name,
        capabilities: ['text'],
        reasoningSupport: 'supported',
        reasoningControl: REASONING_CONTROL,
      },
    ])
    const settings = mountManager(provider, [
      { id: 'stable-chat', name: 'Stable Chat' },
      REASONING_MODEL,
    ])

    await toggleModel(REASONING_MODEL.id)
    await toggleModel(REASONING_MODEL.id)
    await applyChanges()

    expectExactReasoningContract(
      settings.config!.llm.providers[0]!.models.find((model) => model.id === REASONING_MODEL.id),
    )
  })

  it('preserves exact reasoning fields in a managed fallback catalog snapshot', () => {
    expect.hasAssertions()
    const pinia = createPinia()
    setActivePinia(pinia)
    const catalogStore = useModelCatalogStore()
    const persistedModels: ModelOption[] = [
      {
        id: REASONING_MODEL.id,
        name: REASONING_MODEL.name,
        capabilities: ['text'],
        reasoningSupport: 'supported',
        reasoningControl: REASONING_CONTROL,
      },
      ...Array.from(
        { length: 10 },
        (_, index): ModelOption => ({
          id: `fallback-${index}`,
          name: `Fallback ${index}`,
          capabilities: ['text'],
        }),
      ),
    ]

    catalogStore.ensureFallbackCatalog('fallback-provider', persistedModels)

    expectExactReasoningContract(
      catalogStore
        .getCatalog('fallback-provider')
        ?.models.find((model) => model.id === REASONING_MODEL.id),
    )
  })

  it('does not infer reasoning support from the provider or model name', async () => {
    const provider = providerFixture([
      { id: 'stable-chat', name: 'Stable Chat', capabilities: ['text'] },
    ])
    const settings = mountManager(provider, [
      { id: 'stable-chat', name: 'Stable Chat' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ])

    await toggleModel('gpt-5.6-sol')
    await applyChanges()

    const enabled = settings.config!.llm.providers[0]!.models.find(
      (model) => model.id === 'gpt-5.6-sol',
    )
    expect(enabled?.reasoningSupport).toBeUndefined()
    expect(enabled?.reasoningControl).toBeUndefined()
  })
})
