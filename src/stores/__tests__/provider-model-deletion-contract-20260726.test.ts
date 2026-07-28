import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CatalogModel, ModelOption, ProviderConfig } from '@/types'
import {
  reconcileProviderCatalog,
  useModelCatalogStore,
} from '../model-catalog'

function provider(models: ModelOption[] = []): ProviderConfig {
  return {
    id: 'provider-ui-id',
    providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
    backendKey: 'custom-provider',
    name: 'Custom Provider',
    type: 'custom',
    enabled: true,
    apiKey: '****masked',
    baseUrl: 'https://provider.example/v1',
    selectedModelId: models[0]?.id ?? '',
    models,
  }
}

type CatalogStoreWithExclusions = ReturnType<typeof useModelCatalogStore> & {
  excludeModel(providerInstanceId: string, modelId: string): void
  clearModelExclusion(providerInstanceId: string, modelId: string): void
  getExcludedModelIds(providerInstanceId: string): ReadonlySet<string>
}

describe('provider model deletion contract 2026-07-26', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('自定义目录模型与 stale 预设模型可删除，健康预设模型继续受保护', () => {
    const settingsSource = readFileSync(
      resolve(process.cwd(), 'src/views/SettingsView.vue'),
      'utf8',
    )

    expect(settingsSource).toContain('isProviderModelRemovable(provider, model)')
    expect(settingsSource).not.toContain(
      'v-if="model.isCustom || isEmbeddingOnlyModel(model)"',
    )
    expect(settingsSource).not.toMatch(
      /class="hc-model-chip__remove"[\s\S]{0,400}@click\.stop="removeProviderModel\(/,
    )
    expect(settingsSource).toMatch(
      /@click\.stop="[^"]*(?:pendingDeleteModel|requestDelete)[^"]*"/,
    )
    expect(settingsSource).toMatch(/isStaleModel\(provider,\s*model\)[\s\S]{0,240}return true/)
    expect(settingsSource).toMatch(/(?:preset|预设)[\s\S]{0,300}(?:不可删除|not removable)/i)
  })

  it('≤10 小目录自动同步必须减去持久排除集合', () => {
    const target = provider([{ id: 'kept', name: 'Kept', capabilities: ['text'] }])
    const catalog: CatalogModel[] = [
      { id: 'catalog-deleted', name: 'Deleted upstream model' },
      { id: 'catalog-new', name: 'New upstream model' },
    ]
    const reconcileWithExclusions = reconcileProviderCatalog as unknown as (
      target: ProviderConfig,
      remoteModels: CatalogModel[],
      presetDefaults: ModelOption[],
      excludedModelIds: ReadonlySet<string>,
    ) => ReturnType<typeof reconcileProviderCatalog>

    reconcileWithExclusions(target, catalog, [], new Set(['catalog-deleted']))

    expect(target.models.map((model) => model.id)).toEqual(['catalog-new', 'kept'])
  })

  it('删除 tombstone 跨 store 冷启动恢复，显式重新添加才清除', () => {
    const providerInstanceId = provider().providerInstanceId!
    const first = useModelCatalogStore() as CatalogStoreWithExclusions

    expect(typeof first.excludeModel).toBe('function')
    expect(typeof first.getExcludedModelIds).toBe('function')
    expect(typeof first.clearModelExclusion).toBe('function')

    first.excludeModel(providerInstanceId, ' Catalog-Deleted ')

    setActivePinia(createPinia())
    const afterColdStart = useModelCatalogStore() as CatalogStoreWithExclusions
    expect([...afterColdStart.getExcludedModelIds(providerInstanceId)]).toEqual([
      'catalog-deleted',
    ])

    afterColdStart.clearModelExclusion(providerInstanceId, 'catalog-deleted')

    setActivePinia(createPinia())
    const afterExplicitReAdd = useModelCatalogStore() as CatalogStoreWithExclusions
    expect([...afterExplicitReAdd.getExcludedModelIds(providerInstanceId)]).toEqual([])
  })
})
