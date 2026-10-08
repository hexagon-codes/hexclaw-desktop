import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { BackendLLMConfig, ModelOption, ProviderConfig } from '@/types'
import {
  applyCatalogNativeReasoningContract,
  canonicalizeModelOption,
  isChatModelOption,
} from '@/config/model-contract'
import {
  backendToProviders,
  invalidateChangedProviderNativeReasoning,
  providersToBackend,
} from '@/stores/settings-helpers'
import { reconcileProviderCatalog, useModelCatalogStore } from '@/stores/model-catalog'

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060' },
  OLLAMA_BASE: 'http://localhost:11434',
}))
vi.mock('@/utils/platform', () => ({ isTauri: vi.fn(() => false) }))

const control = { dialect: 'think' as const, on: true, off: false }

function model(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: 'exact-model',
    name: 'Exact model',
    capabilities: ['text'],
    reasoningSupport: 'unknown',
    nativeReasoningSupport: 'supported',
    nativeReasoningSourceFingerprint: 'model-source-a',
    ...overrides,
  }
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'card-a',
    providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
    nativeReasoningSourceFingerprint: 'provider-source-a',
    backendKey: 'provider-a',
    name: 'Provider A',
    type: 'custom',
    enabled: true,
    baseUrl: 'https://a.example/v1',
    apiKey: 'test-credential-a',
    models: [model()],
    selectedModelId: 'exact-model',
    ...overrides,
  }
}

function backend(specs: BackendLLMConfig['providers'][string]['model_specs']): BackendLLMConfig {
  return {
    default: 'provider-a',
    providers: {
      'provider-a': {
        provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
        native_reasoning_source_fingerprint: 'provider-source-a',
        base_url: 'https://a.example/v1',
        model: 'exact-model',
        models: ['exact-model'],
        model_specs: specs,
        compatible: 'openai',
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})
afterEach(() => vi.unstubAllGlobals())

describe('native reasoning data contract', () => {
  it.each(['supported', 'unsupported', 'unknown'] as const)(
    'round-trips static %s without enabling controls',
    (support) => {
      const source = provider({ models: [model({ nativeReasoningSupport: support })] })
      const wire = providersToBackend([source], 'exact-model', source.id)
      expect(wire.providers['provider-a']!.model_specs![0]).toMatchObject({
        native_reasoning_support: support,
        native_reasoning_source_fingerprint: 'model-source-a',
        reasoning_support: 'unknown',
        capabilities: ['text'],
      })
      const restored = backendToProviders(wire)[0]!.models[0]!
      expect(restored.nativeReasoningSupport).toBe(support)
      expect(restored.reasoningSupport).toBe('unknown')
      expect(restored.reasoningControl).toBeUndefined()
      expect(isChatModelOption(restored)).toBe(true)
    },
  )

  it('keeps effective positive evidence read-only and independent from a static unknown', () => {
    const data = backend([
      {
        id: 'exact-model',
        display_name: 'Exact model',
        capabilities: ['text'],
        native_reasoning_support: 'unknown',
        native_reasoning_source_fingerprint: 'model-source-a',
        reasoning_support: 'unknown',
      },
    ])
    data.providers['provider-a']!.effective_models = [
      {
        id: 'exact-model',
        capabilities: ['text'],
        effective_native_reasoning_support: 'supported',
        native_reasoning_source_fingerprint: 'model-source-a',
      },
    ]
    const restored = backendToProviders(data)
    expect(restored[0]!.models[0]).toMatchObject({
      nativeReasoningSupport: 'unknown',
      effectiveNativeReasoningSupport: 'supported',
      reasoningSupport: 'unknown',
      capabilities: ['text'],
    })
    const saved = providersToBackend(restored, 'exact-model', restored[0]!.id)
    expect(saved.providers['provider-a']!.model_specs![0]!.native_reasoning_support).toBe('unknown')
    expect(JSON.stringify(saved)).not.toContain('effective_native_reasoning_support')
    expect(JSON.stringify(saved)).not.toContain('effectiveNativeReasoningSupport')
  })

  it('normalizes an invalid native state without guessing from a valid control contract', () => {
    const invalid = canonicalizeModelOption({
      ...model({ reasoningSupport: 'supported', reasoningControl: control }),
      nativeReasoningSupport: 'true',
    } as unknown as ModelOption)
    expect(invalid.nativeReasoningSupport).toBe('unknown')
    expect(invalid.reasoningSupport).toBe('supported')
    expect(invalid.reasoningControl).toEqual(control)
    expect(invalid.capabilities).toEqual(['text'])
  })

  it('merges native and control declarations independently, with explicit unknown winning', () => {
    const existing = model({ reasoningSupport: 'supported', reasoningControl: control })
    const absent = applyCatalogNativeReasoningContract(existing, {
      nativeReasoningSourceFingerprint: 'model-source-a',
    })
    expect(absent.nativeReasoningSupport).toBe('supported')
    const explicit = applyCatalogNativeReasoningContract(existing, {
      nativeReasoningSupport: 'unknown',
      nativeReasoningSourceFingerprint: 'model-source-a',
    })
    expect(explicit.nativeReasoningSupport).toBe('unknown')
    expect(explicit.reasoningControl).toEqual(control)
    const staleEffective = applyCatalogNativeReasoningContract(
      model({
        nativeReasoningSupport: 'unknown',
        effectiveNativeReasoningSupport: 'unknown',
        effectiveNativeReasoningSourceFingerprint: 'model-source-a',
      }),
      { nativeReasoningSupport: 'supported', nativeReasoningSourceFingerprint: 'model-source-a' },
    )
    expect(staleEffective.nativeReasoningSupport).toBe('supported')
    expect(staleEffective.effectiveNativeReasoningSupport).toBeUndefined()
    const independentPositive = applyCatalogNativeReasoningContract(
      model({
        nativeReasoningSupport: 'unknown',
        effectiveNativeReasoningSupport: 'supported',
        effectiveNativeReasoningSourceFingerprint: 'model-source-a',
      }),
      { nativeReasoningSupport: 'unsupported', nativeReasoningSourceFingerprint: 'model-source-a' },
    )
    expect(independentPositive.effectiveNativeReasoningSupport).toBe('supported')
    const target = provider({ models: [existing] })
    reconcileProviderCatalog(
      target,
      [
        {
          id: 'exact-model',
          name: 'Updated',
          nativeReasoningSupport: 'unsupported',
          nativeReasoningSourceFingerprint: 'model-source-a',
        },
      ],
      [],
    )
    expect(target.models[0]).toMatchObject({
      nativeReasoningSupport: 'unsupported',
      reasoningSupport: 'supported',
      reasoningControl: control,
      capabilities: ['text'],
    })
  })

  it('binds omitted declarations to exact model and current source rather than another model', () => {
    const local = provider({
      models: [
        model(),
        model({
          id: 'other-model',
          nativeReasoningSupport: 'unsupported',
          nativeReasoningSourceFingerprint: 'other-source',
        }),
      ],
    })
    const data = backend([
      {
        id: 'exact-model',
        display_name: 'Exact model',
        capabilities: ['text'],
        native_reasoning_source_fingerprint: 'model-source-a',
      },
      {
        id: 'other-model',
        display_name: 'Other',
        capabilities: ['text'],
        native_reasoning_source_fingerprint: 'other-source',
      },
    ])
    data.providers['provider-a']!.models = ['exact-model', 'other-model']
    const restored = backendToProviders(data, [local])[0]!
    expect(restored.models.map((entry) => entry.nativeReasoningSupport)).toEqual([
      'supported',
      'unsupported',
    ])
    data.providers['provider-a']!.native_reasoning_source_fingerprint = 'provider-source-b'
    expect(
      backendToProviders(data, [local])[0]!.models.map((entry) => entry.nativeReasoningSupport),
    ).toEqual(['unknown', 'unknown'])
  })
})

describe('native reasoning physical source isolation', () => {
  it.each([
    { baseUrl: 'https://b.example/v1' },
    { apiKey: 'test-credential-b' },
    { providerInstanceId: 'pvd_v1_ffeeddccbbaa99887766554433221100' },
  ])('invalidates only native values on source change %j', (change) => {
    const previous = provider({
      models: [
        model({
          reasoningSupport: 'supported',
          reasoningControl: control,
          effectiveNativeReasoningSupport: 'supported',
          effectiveNativeReasoningSourceFingerprint: 'model-source-a',
        }),
      ],
    })
    const next = structuredClone(previous)
    Object.assign(next, change)
    invalidateChangedProviderNativeReasoning(previous, next)
    expect(next.nativeReasoningSourceFingerprint).toBeUndefined()
    expect(next.models[0]).toMatchObject({
      nativeReasoningSupport: 'unknown',
      reasoningSupport: 'supported',
      reasoningControl: control,
      capabilities: ['text'],
    })
    expect(next.models[0]!.effectiveNativeReasoningSupport).toBeUndefined()
    expect(next.selectedModelId).toBe('exact-model')
  })

  it('preserves native evidence for a name/default change and normalized trailing slash', () => {
    const previous = provider()
    const next = {
      ...previous,
      name: 'Renamed',
      backendKey: 'renamed',
      selectedModelId: 'another-default',
      baseUrl: `${previous.baseUrl}/`,
    }
    invalidateChangedProviderNativeReasoning(previous, next)
    expect(next.models[0]!.nativeReasoningSupport).toBe('supported')
    expect(next.nativeReasoningSourceFingerprint).toBe('provider-source-a')
  })

  it('preserves the owner credential when a plaintext presentation becomes a masked preserve value', () => {
    const previous = provider({ credentialRef: 'opaque-ref' })
    const next = { ...previous, apiKey: '********', apiKeyMutation: 'preserve' as const }
    invalidateChangedProviderNativeReasoning(previous, next)
    expect(next.models[0]!.nativeReasoningSupport).toBe('supported')
  })

  it.each([
    { baseUrl: 'https://b.example/v1' },
    { apiKey: 'test-credential-b' },
    { providerInstanceId: 'pvd_v1_ffeeddccbbaa99887766554433221100' },
    { nativeReasoningSourceFingerprint: 'provider-source-b' },
  ])('prevents an old catalog native declaration from being reimported after %j', (change) => {
    const store = useModelCatalogStore()
    const current = provider()
    store.setCatalog(
      current.id,
      [
        {
          id: 'exact-model',
          name: 'Exact',
          nativeReasoningSupport: 'supported',
          nativeReasoningSourceFingerprint: 'model-source-a',
          reasoningSupport: 'supported',
          reasoningControl: control,
        },
      ],
      current,
    )
    Object.assign(current, change)
    const stale = store.getCatalog(current.id, current)!
    expect(stale.models[0]).toMatchObject({
      nativeReasoningSupport: 'unknown',
      reasoningSupport: 'supported',
      reasoningControl: control,
    })
    expect(stale.models[0]!.nativeReasoningSourceFingerprint).toBeUndefined()
    current.models = [model({ nativeReasoningSupport: 'unknown' })]
    reconcileProviderCatalog(current, stale.models, [])
    expect(current.models[0]!.nativeReasoningSupport).toBe('unknown')
  })

  it('retains same-source cached declarations across rename and rehydration without saving credentials', () => {
    const current = provider()
    const store = useModelCatalogStore()
    store.setCatalog(
      current.id,
      [
        {
          id: 'exact-model',
          name: 'Exact',
          nativeReasoningSupport: 'supported',
          nativeReasoningSourceFingerprint: 'model-source-a',
        },
      ],
      current,
    )
    current.name = 'Renamed'
    current.backendKey = 'renamed'
    expect(store.getCatalog(current.id, current)!.models[0]!.nativeReasoningSupport).toBe(
      'supported',
    )
    current.apiKey = '********'
    current.apiKeyMutation = 'preserve'
    expect(store.getCatalog(current.id, current)!.models[0]!.nativeReasoningSupport).toBe(
      'supported',
    )
    const stored = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.getItem(localStorage.key(index)!),
    ).join('')
    expect(stored).not.toContain('test-credential-a')
    expect(stored).not.toContain('credentialSummary')
    expect(stored).not.toContain('apiKey')
    setActivePinia(createPinia())
    expect(
      useModelCatalogStore().getCatalog(current.id, current)!.models[0]!.nativeReasoningSupport,
    ).toBe('supported')
  })
})

describe('native reasoning catalog transport', () => {
  it('preserves explicit tri-state/absence and ignores unrelated native boolean-looking fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          text: async () =>
            JSON.stringify({
              models: [
                {
                  id: 'positive',
                  native_reasoning_support: 'supported',
                  native_reasoning_source_fingerprint: 'positive-source',
                },
                { id: 'negative', native_reasoning_support: 'unsupported' },
                { id: 'unknown', native_reasoning_support: 'unknown' },
                { id: 'invalid', native_reasoning_support: 'yes', supports_reasoning: true },
                { id: 'absent' },
              ],
            }),
        }),
    )
    const { fetchProviderModels } = await import('@/api/config')
    const catalog = await fetchProviderModels('https://a.example/v1', 'test-key')
    expect(catalog.map((entry) => entry.nativeReasoningSupport)).toEqual([
      'supported',
      'unsupported',
      'unknown',
      'unknown',
      undefined,
    ])
    expect(catalog[0]!.nativeReasoningSourceFingerprint).toBe('positive-source')
    expect(
      catalog.every(
        (entry) => entry.reasoningSupport === undefined && entry.reasoningControl === undefined,
      ),
    ).toBe(true)
  })
})
