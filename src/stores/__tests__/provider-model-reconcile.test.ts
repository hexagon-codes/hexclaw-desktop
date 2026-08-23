import { describe, expect, it } from 'vitest'
import type { CatalogModel, ModelOption, ProviderConfig } from '@/types'
import {
  beginProviderCatalogSync,
  reconcileProviderCatalog,
} from '../model-catalog'

function provider(models: ModelOption[]): ProviderConfig {
  return {
    id: 'frontend-provider',
    providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
    backendKey: 'backend-provider',
    name: 'Provider',
    type: 'custom',
    enabled: true,
    apiKey: '****masked',
    baseUrl: 'https://a.example/v1',
    selectedModelId: models[0]?.id ?? '',
    models,
  }
}

describe('provider catalog reconciliation', () => {
  it('10→4 时自动启用新的四项、刷新名称，并把上游缺失的既有启用项保留为 stale', () => {
    const existing = Array.from({ length: 10 }, (_, index): ModelOption => ({
      id: `model-${index}`,
      name: `Old ${index}`,
      capabilities: ['text'],
    }))
    const target = provider(existing)
    const catalog: CatalogModel[] = Array.from({ length: 4 }, (_, index) => ({
      id: `model-${index}`,
      name: `Renamed ${index}`,
    }))

    const result = reconcileProviderCatalog(target, catalog, [])

    expect(result).toEqual({ changed: true, managed: false })
    expect(target.models).toHaveLength(10)
    expect(target.models.slice(0, 4).map((model) => model.name)).toEqual([
      'Renamed 0',
      'Renamed 1',
      'Renamed 2',
      'Renamed 3',
    ])
    expect(target.models.slice(4).map((model) => model.id)).toEqual([
      'model-4',
      'model-5',
      'model-6',
      'model-7',
      'model-8',
      'model-9',
    ])
  })

  it('小目录新增项全部启用，同时保留自定义、生成、向量和普通下架模型的完整契约', () => {
    const target = provider([
      { id: 'old-chat', name: 'Old Chat', capabilities: ['text'] },
      { id: 'custom', name: 'Custom', capabilities: ['text'], isCustom: true },
      { id: 'image', name: 'Image', capabilities: ['image_generation'] },
      {
        id: 'embed',
        name: 'Embed',
        capabilities: ['embedding'],
        embedding: { protocol: 'openai_embeddings', dimension: 1024, normalization: 'l2' },
      },
    ])

    reconcileProviderCatalog(
      target,
      [
        { id: 'new-chat', name: 'New Chat' },
        { id: 'new-vision', name: 'New Vision', inputModalities: ['text', 'image'] },
      ],
      [{ id: 'new-vision', name: 'New Vision', capabilities: ['text', 'vision'] }],
    )

    expect(target.models.map((model) => model.id)).toEqual([
      'new-chat',
      'new-vision',
      'old-chat',
      'custom',
      'image',
      'embed',
    ])
    expect(target.models.find((model) => model.id === 'embed')?.embedding?.dimension).toBe(1024)
  })

  it('大目录不会用启发式删除既有启用集合，也不把未启用项自动加入', () => {
    const catalog = Array.from({ length: 300 }, (_, index) => ({
      id: `catalog-${index}`,
      name: `Catalog ${index}`,
    }))
    const target = provider([
      ...catalog.map((model): ModelOption => ({ ...model, capabilities: ['text'] })),
      { id: 'custom', name: 'Custom', capabilities: ['text'], isCustom: true },
    ])
    target.selectedModelId = 'catalog-0'

    const result = reconcileProviderCatalog(target, catalog, [])

    expect(result).toEqual({ changed: false, managed: true })
    expect(target.models).toHaveLength(301)
    expect(target.models.map((model) => model.id)).toEqual([
      ...catalog.map((model) => model.id),
      'custom',
    ])
  })

  it('大目录只回填已启用同 ID 的远端名称，不以目录 input modalities 提升静态能力', () => {
    const target = provider([
      { id: 'catalog-long', name: 'Stale long model name', capabilities: ['text'] },
      { id: 'selected-only', name: 'Selected only', capabilities: ['text'] },
    ])
    const catalog: CatalogModel[] = [
      {
        id: 'catalog-long',
        name: 'NVIDIA: Nemotron Ultra Long Free Vision Model for Layout Regression',
        promptPrice: '0',
        completionPrice: '0',
        inputModalities: ['text', 'image'],
        supportsTools: true,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `remote-only-${index}`,
        name: `Remote only ${index}`,
      })),
    ]

    const result = reconcileProviderCatalog(target, catalog, [])

    expect(result).toEqual({ changed: true, managed: true })
    expect(target.models.map((model) => model.id)).toEqual(['catalog-long', 'selected-only'])
    expect(target.models[0]).toMatchObject({
      id: 'catalog-long',
      name: 'NVIDIA: Nemotron Ultra Long Free Vision Model for Layout Regression',
      capabilities: ['text'],
    })
    expect(target.models.find((model) => model.id === 'remote-only-0')).toBeUndefined()
  })

  it('小目录中的裸模型保持未分类，不以模型 ID 或目录输入模态合成 text/vision', () => {
    const target = provider([])

    reconcileProviderCatalog(
      target,
      [{
        id: 'vendor/vision-image-model',
        name: 'Vision image model',
        inputModalities: ['text', 'image'],
      }],
      [],
    )

    expect(target.models).toEqual([
      expect.objectContaining({
        id: 'vendor/vision-image-model',
        capabilities: [],
      }),
    ])
  })
})

describe('provider catalog sync generation', () => {
  it('endpoint 或 identity 变化后，旧请求即使后返回也不再拥有写权限', () => {
    const target = provider([{ id: 'old', name: 'Old', capabilities: ['text'] }])
    const oldSync = beginProviderCatalogSync(target, target.baseUrl)

    target.baseUrl = 'https://b.example/v1'
    const newSync = beginProviderCatalogSync(target, target.baseUrl)

    expect(oldSync.isCurrent(target, target.baseUrl)).toBe(false)
    expect(newSync.isCurrent(target, target.baseUrl)).toBe(true)

    target.providerInstanceId = 'pvd_v1_ffeeddccbbaa99887766554433221100'
    expect(newSync.isCurrent(target, target.baseUrl)).toBe(false)
  })

  it('provider 被禁用后，禁用前发出的响应不再拥有写权限', () => {
    const target = provider([])
    const lease = beginProviderCatalogSync(target, target.baseUrl)

    target.enabled = false

    expect(lease.isCurrent(target, target.baseUrl)).toBe(false)
  })

  it('API Key 变化后旧请求不再拥有写权限', () => {
    const target = provider([])
    target.apiKey = 'sk-before'
    const lease = beginProviderCatalogSync(target, target.baseUrl)

    target.apiKey = 'sk-after'

    expect(lease.isCurrent(target, target.baseUrl)).toBe(false)
  })

  it('API Key 的原始请求值变化后旧请求不再拥有写权限', () => {
    const target = provider([])
    target.apiKey = 'sk-value'
    const lease = beginProviderCatalogSync(target, target.baseUrl)

    target.apiKey = 'sk-value '

    expect(lease.isCurrent(target, target.baseUrl)).toBe(false)
  })

  it('provider type 变化后旧请求不再拥有写权限', () => {
    const target = provider([])
    const lease = beginProviderCatalogSync(target, target.baseUrl)

    target.type = 'openai'

    expect(lease.isCurrent(target, target.baseUrl)).toBe(false)
  })

  it('同一 endpoint 连续同步时也只允许最新 generation 落地', () => {
    const target = provider([])
    const first = beginProviderCatalogSync(target, target.baseUrl)
    const second = beginProviderCatalogSync(target, target.baseUrl)

    expect(first.isCurrent(target, target.baseUrl)).toBe(false)
    expect(second.isCurrent(target, target.baseUrl)).toBe(true)
  })
})
