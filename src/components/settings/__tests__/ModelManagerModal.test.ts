import { beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ModelManagerModal from '../ModelManagerModal.vue'
import { useSettingsStore } from '@/stores/settings'
import { useModelCatalogStore } from '@/stores/model-catalog'
import { defaultConfig } from '@/stores/settings-defaults'
import zhCN from '@/i18n/locales/zh-CN'
import type { CatalogModel, ProviderConfig } from '@/types'

const EMBEDDING_MODEL_ID = 'nvidia/nemotron-3-embed-1b:free'

function providerFixture(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'custom',
    enabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://openrouter.ai/api/v1',
    selectedModelId: 'chat-a',
    models: [{ id: 'chat-a', name: 'Chat A', capabilities: ['text'] }],
    ...overrides,
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
  const catalogStore = useModelCatalogStore()
  catalogStore.setCatalog(provider.id, catalog)

  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
  const wrapper = mount(ModelManagerModal, {
    props: { open: true, provider },
    global: {
      plugins: [pinia, i18n],
      stubs: {
        HcClearableField: { template: '<div><slot /></div>' },
      },
    },
  })
  return { wrapper, settings, catalogStore }
}

function dialogBody() {
  return new DOMWrapper(document.body)
}

function modelRow(id: string) {
  const row = dialogBody()
    .findAll('.mm-row')
    .find((candidate) => candidate.text().includes(id))
  if (!row) throw new Error(`model row not found: ${id}`)
  return row
}

async function toggleModelRow(id: string) {
  await dialogBody().get(`[data-testid="model-manager-toggle-${id}"]`).trigger('click')
}

describe('ModelManagerModal — catalog to enabled-pool contract', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('stages model toggles and discards them when cancelled', async () => {
    const provider = providerFixture()
    const { settings } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: 'chat-b', name: 'Chat B' },
    ])

    await toggleModelRow('chat-b')
    expect(settings.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual(['chat-a'])

    await dialogBody().get('[data-testid="model-manager-cancel"]').trigger('click')
    expect(settings.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual(['chat-a'])
  })

  it('shows the last successful catalog sync beside exactly one resync action', () => {
    const provider = providerFixture()
    const { catalogStore } = mountManager(provider, [{ id: 'chat-a', name: 'Chat A' }])
    const syncedAt = catalogStore.getCatalog(provider.id)!.syncedAt
    const body = dialogBody()

    expect(body.get('[data-testid="model-manager-last-sync"]').text()).toContain('上次成功同步')
    expect(body.get('[data-testid="model-manager-last-sync"]').attributes('data-synced-at')).toBe(
      syncedAt,
    )
    expect(body.findAll('[data-testid="model-manager-resync"]')).toHaveLength(1)
  })

  it('filters chat and embedding models without relying on optional provider metadata', async () => {
    const provider = providerFixture()
    mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: EMBEDDING_MODEL_ID, name: 'Nemotron Embed' },
    ])

    const body = dialogBody()
    expect(body.find('[data-testid="model-manager-filter-chat"]').exists()).toBe(true)
    expect(body.find('[data-testid="model-manager-filter-embedding"]').exists()).toBe(true)

    await body.get('[data-testid="model-manager-filter-embedding"]').trigger('click')
    const visibleRows = dialogBody().findAll('.mm-row')
    expect(visibleRows).toHaveLength(1)
    expect(visibleRows[0]!.text()).toContain(EMBEDDING_MODEL_ID)
  })

  it('searches an OpenRouter-sized catalog without adding the catalog to the enabled pool', async () => {
    const provider = providerFixture()
    const catalog = Array.from({ length: 342 }, (_, index) => ({
      id: `vendor-${index % 20}/model-${index}`,
      name: `Model ${index}`,
    }))
    const { settings } = mountManager(provider, catalog)

    await dialogBody().get('.mm-search input').setValue('vendor-1/model-341')
    const visibleRows = dialogBody().findAll('.mm-row')
    expect(visibleRows).toHaveLength(1)
    expect(visibleRows[0]!.text()).toContain('vendor-1/model-341')
    expect(settings.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual(['chat-a'])
  })

  it('keeps an upstream-removed enabled model visible so the user can disable it explicitly', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'legacy-chat', name: 'Legacy Chat', capabilities: ['text'] },
      ],
    })
    const { settings } = mountManager(provider, [{ id: 'chat-a', name: 'Chat A' }])

    expect(modelRow('legacy-chat').text()).toContain('已下架')
    await toggleModelRow('legacy-chat')
    await dialogBody().get('[data-testid="model-manager-apply"]').trigger('click')
    await flushPromises()

    expect(settings.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual(['chat-a'])
  })

  it('does not mislabel a user-defined model as removed upstream', () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        {
          id: 'private-model',
          name: 'Private Model',
          capabilities: ['text'],
          isCustom: true,
        },
      ],
    })
    mountManager(provider, [{ id: 'chat-a', name: 'Chat A' }])

    expect(modelRow('private-model').text()).not.toContain('已下架')
  })

  it('applies a canonical embedding model without replacing the chat default', async () => {
    const provider = providerFixture()
    const { settings } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: EMBEDDING_MODEL_ID, name: 'Nemotron Embed' },
    ])

    await toggleModelRow(EMBEDDING_MODEL_ID)
    expect(settings.config!.llm.providers[0]!.models).toHaveLength(1)

    await dialogBody().get('[data-testid="model-manager-apply"]').trigger('click')
    await flushPromises()

    const updated = settings.config!.llm.providers[0]!
    expect(updated.models.find((model) => model.id === EMBEDDING_MODEL_ID)).toMatchObject({
      capabilities: ['embedding'],
      embedding: {
        protocol: 'openai_embeddings',
        dimension: 2048,
        normalization: 'l2',
      },
    })
    expect(updated.selectedModelId).toBe('chat-a')
    expect(settings.config!.llm.defaultModel).toBe('chat-a')
  })

  it('never falls back to an embedding model when the current chat model is disabled', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        {
          id: EMBEDDING_MODEL_ID,
          name: 'Nemotron Embed',
          capabilities: ['embedding'],
          embedding: {
            protocol: 'openai_embeddings',
            dimension: 2048,
            normalization: 'l2',
          },
        },
      ],
    })
    const { settings } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: EMBEDDING_MODEL_ID, name: 'Nemotron Embed' },
    ])

    await toggleModelRow('chat-a')
    await dialogBody().get('[data-testid="model-manager-apply"]').trigger('click')
    await flushPromises()

    expect(settings.config!.llm.providers[0]!.selectedModelId).toBe('')
    expect(settings.config!.llm.defaultModel).toBe('')
  })

  it('requires an explicit replacement when disabling the current chat model', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'chat-b', name: 'Chat B', capabilities: ['text'] },
      ],
    })
    const { settings } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: 'chat-b', name: 'Chat B' },
    ])

    await toggleModelRow('chat-a')
    const body = dialogBody()
    expect(body.get('[data-testid="model-manager-replacement-required"]').text()).toContain(
      '请选择一个当前对话模型',
    )
    expect(
      body.get<HTMLButtonElement>('[data-testid="model-manager-apply"]').element.disabled,
    ).toBe(true)

    await body.get('[data-testid="model-manager-select-chat-b"]').trigger('click')
    expect(
      body.get<HTMLButtonElement>('[data-testid="model-manager-apply"]').element.disabled,
    ).toBe(false)
    await body.get('[data-testid="model-manager-apply"]').trigger('click')
    await flushPromises()

    expect(settings.config!.llm.providers[0]!.selectedModelId).toBe('chat-b')
    expect(settings.config!.llm.defaultModel).toBe('chat-b')
  })

  it('rebases explicit draft removals onto the latest provider state after resync', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'chat-b', name: 'Chat B', capabilities: ['text'] },
      ],
    })
    const { wrapper, settings, catalogStore } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: 'chat-b', name: 'Chat B' },
    ])

    await toggleModelRow('chat-b')
    await wrapper.setProps({ syncing: true })
    catalogStore.setCatalog(provider.id, [
      { id: 'chat-a', name: 'Chat A (latest)', inputModalities: ['text', 'image'] },
      { id: 'chat-b', name: 'Chat B (latest)' },
    ])
    await wrapper.setProps({
      provider: {
        ...provider,
        models: [
          { id: 'chat-a', name: 'Chat A (synced)', capabilities: ['text'] },
          { id: 'chat-b', name: 'Chat B (synced)', capabilities: ['text'] },
        ],
      },
      syncing: false,
    })
    await flushPromises()

    expect(
      dialogBody()
        .get<HTMLButtonElement>('[data-testid="model-manager-toggle-chat-b"]')
        .attributes('aria-checked'),
    ).toBe('false')
    await dialogBody().get('[data-testid="model-manager-apply"]').trigger('click')
    await flushPromises()

    expect(settings.config!.llm.providers[0]!.models).toEqual([
      expect.objectContaining({
        id: 'chat-a',
        name: 'Chat A (latest)',
        capabilities: ['text', 'vision'],
      }),
    ])
  })

  it('adopts a resync migration when the user has not changed the draft', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'legacy-flooded', name: 'Legacy Flooded', capabilities: ['text'] },
      ],
    })
    const { wrapper } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: 'legacy-flooded', name: 'Legacy Flooded' },
    ])

    await wrapper.setProps({ syncing: true })
    await wrapper.setProps({
      provider: {
        ...provider,
        models: [{ id: 'chat-a', name: 'Chat A', capabilities: ['text'] }],
      },
      syncing: false,
    })
    await flushPromises()

    expect(
      dialogBody()
        .get<HTMLButtonElement>('[data-testid="model-manager-toggle-legacy-flooded"]')
        .attributes('aria-checked'),
    ).toBe('false')
    expect(
      dialogBody().get<HTMLButtonElement>('[data-testid="model-manager-apply"]').element.disabled,
    ).toBe(true)
  })

  it('preserves a newly selected baseline model when resync migration trims it', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'chat-b', name: 'Chat B', capabilities: ['text'] },
      ],
    })
    const { wrapper, settings } = mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: 'chat-b', name: 'Chat B' },
    ])

    await dialogBody().get('[data-testid="model-manager-select-chat-b"]').trigger('click')
    await wrapper.setProps({ syncing: true })
    await wrapper.setProps({
      provider: {
        ...provider,
        models: [{ id: 'chat-a', name: 'Chat A', capabilities: ['text'] }],
      },
      syncing: false,
    })
    await flushPromises()

    expect(
      dialogBody().get('[data-testid="model-manager-toggle-chat-b"]').attributes('aria-checked'),
    ).toBe('true')
    expect(dialogBody().get('[data-testid="model-manager-select-chat-b"]').text()).toContain('当前')
    await dialogBody().get('[data-testid="model-manager-apply"]').trigger('click')
    await flushPromises()

    expect(settings.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual([
      'chat-a',
      'chat-b',
    ])
    expect(settings.config!.llm.providers[0]!.selectedModelId).toBe('chat-b')
  })

  it('keeps a stale baseline model visible when a resync payload omits it', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'stale-chat', name: 'Stale Chat', capabilities: ['text'] },
      ],
    })
    const { wrapper } = mountManager(provider, [{ id: 'chat-a', name: 'Chat A' }])

    await wrapper.setProps({ syncing: true })
    await wrapper.setProps({
      provider: {
        ...provider,
        models: [{ id: 'chat-a', name: 'Chat A', capabilities: ['text'] }],
      },
      syncing: false,
    })
    await flushPromises()

    expect(modelRow('stale-chat').text()).toContain('已下架')
    expect(
      dialogBody()
        .get('[data-testid="model-manager-toggle-stale-chat"]')
        .attributes('aria-checked'),
    ).toBe('true')
  })

  it('persists trusted catalog capability enrichment instead of stale enabled metadata', async () => {
    const provider = providerFixture()
    const { settings } = mountManager(provider, [
      {
        id: 'chat-a',
        name: 'Chat A Vision',
        inputModalities: ['text', 'image'],
      },
    ])

    const apply = dialogBody().get<HTMLButtonElement>('[data-testid="model-manager-apply"]')
    expect(apply.element.disabled).toBe(false)
    await apply.trigger('click')
    await flushPromises()

    expect(settings.config!.llm.providers[0]!.models[0]).toMatchObject({
      id: 'chat-a',
      name: 'Chat A Vision',
      capabilities: ['text', 'vision'],
    })
  })

  it('keeps keyboard focus inside the modal in both tab directions', async () => {
    mountManager(providerFixture(), [{ id: 'chat-a', name: 'Chat A' }])
    await flushPromises()

    const modal = dialogBody().get('.mm-modal').element
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!

    last.focus()
    await dialogBody().get('.hc-dialog-overlay').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    await dialogBody().get('.hc-dialog-overlay').trigger('keydown', {
      key: 'Tab',
      shiftKey: true,
    })
    expect(document.activeElement).toBe(last)
  })

  it('exposes sibling switch/current controls and explicit filter states', async () => {
    const provider = providerFixture({
      models: [
        { id: 'chat-a', name: 'Chat A', capabilities: ['text'] },
        { id: 'chat-b', name: 'Chat B', capabilities: ['text'] },
      ],
    })
    mountManager(provider, [
      { id: 'chat-a', name: 'Chat A' },
      { id: 'chat-b', name: 'Chat B' },
    ])

    const row = modelRow('chat-b')
    expect(row.attributes('role')).toBeUndefined()
    expect(row.find('button[role="switch"]').exists()).toBe(true)
    expect(row.find('button[role="switch"] button').exists()).toBe(false)
    const currentButton = row.get('[data-testid="model-manager-select-chat-b"]')
    const switchButton = row.get('[data-testid="model-manager-toggle-chat-b"]')
    expect(
      currentButton.element.compareDocumentPosition(switchButton.element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await row.get('.mm-switch').trigger('click')
    expect(switchButton.attributes('aria-checked')).toBe('false')
    expect(
      dialogBody().get('[data-testid="model-manager-filter-chat"]').attributes('aria-pressed'),
    ).toBe('false')
    expect(dialogBody().get('.mm-search input').attributes('aria-label')).toBeTruthy()
  })
})
