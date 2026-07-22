import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CatalogModel, ModelOption, ProviderConfig } from '@/types'

const mockFetchProviderModels = vi.hoisted(() => vi.fn())

vi.mock('@/api/config', () => ({
  fetchProviderModels: (...args: unknown[]) => mockFetchProviderModels(...args),
}))

import { useModelCatalogStore } from '../model-catalog'
import { syncProviderModelCatalogs } from '../provider-model-sync'

function provider(): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'Provider',
    type: 'custom',
    enabled: true,
    apiKey: 'key',
    baseUrl: 'https://api.example.com/v1',
    selectedModelId: 'model-1',
    models: [{ id: 'model-1', name: 'Model 1', capabilities: ['text'] }],
  }
}

function syncCatalog() {
  const configured = provider()
  syncProviderModelCatalogs([configured], {
    getConfiguredProviders: () => [configured],
    getRuntimeProviders: () => null,
    persistChangedProviders: vi.fn(),
  })
}

function syncConfiguredProvider(configured: ProviderConfig) {
  const persistChangedProviders = vi.fn()
  syncProviderModelCatalogs([configured], {
    getConfiguredProviders: () => [configured],
    getRuntimeProviders: () => null,
    persistChangedProviders,
  })
  return { persistChangedProviders }
}

function configuredModels(count: number): ModelOption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `configured-${index}`,
    name: `Configured ${index}`,
    capabilities: ['text'],
  }))
}

describe('provider model catalog background sync isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockFetchProviderModels.mockReset()
  })

  it('absorbs a synchronous adapter throw instead of escaping the background refresh', () => {
    mockFetchProviderModels.mockImplementationOnce(() => {
      throw new Error('legacy adapter unavailable')
    })

    expect(syncCatalog).not.toThrow()
  })

  it('absorbs an asynchronous adapter rejection and leaves persisted models unchanged', async () => {
    mockFetchProviderModels.mockRejectedValueOnce(new Error('remote catalog unavailable'))

    expect(syncCatalog).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockFetchProviderModels).toHaveBeenCalledTimes(1)
  })

  it('exposes persisted models as a fallback managed catalog when remote refresh fails', async () => {
    mockFetchProviderModels.mockRejectedValueOnce(new Error('remote catalog unavailable'))
    const configured = provider()
    configured.models = configuredModels(11)
    configured.selectedModelId = configured.models[0]!.id
    const originalModels = structuredClone(configured.models)

    const { persistChangedProviders } = syncConfiguredProvider(configured)
    await Promise.resolve()
    await Promise.resolve()

    expect(useModelCatalogStore().getCatalog(configured.id)).toMatchObject({
      source: 'fallback',
      models: originalModels.map(({ id, name }) => ({ id, name })),
      newIds: [],
    })
    expect(configured.models).toEqual(originalModels)
    expect(persistChangedProviders).not.toHaveBeenCalled()
  })

  it('atomically replaces a fallback catalog after a later remote refresh succeeds', async () => {
    const configured = provider()
    configured.models = configuredModels(11)
    configured.selectedModelId = configured.models[0]!.id
    const remoteModels: CatalogModel[] = Array.from({ length: 12 }, (_, index) => ({
      id: `remote-${index}`,
      name: `Remote ${index}`,
    }))
    mockFetchProviderModels.mockResolvedValueOnce(remoteModels)

    syncConfiguredProvider(configured)
    expect(useModelCatalogStore().getCatalog(configured.id)).toMatchObject({
      source: 'fallback',
      models: configured.models.map(({ id, name }) => ({ id, name })),
    })
    await vi.waitFor(() =>
      expect(useModelCatalogStore().getCatalog(configured.id)).toMatchObject({
        source: 'remote',
        models: remoteModels,
      }),
    )
  })

  it('does not create a managed fallback catalog for four persisted models', async () => {
    mockFetchProviderModels.mockRejectedValueOnce(new Error('remote catalog unavailable'))
    const configured = provider()
    configured.models = configuredModels(4)
    configured.selectedModelId = configured.models[0]!.id

    syncConfiguredProvider(configured)
    await Promise.resolve()
    await Promise.resolve()

    expect(useModelCatalogStore().getCatalog(configured.id)).toBeNull()
  })
})
