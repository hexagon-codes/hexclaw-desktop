import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderConfig, ModelOption, BackendLLMConfig, AppConfig } from '@/types'

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn(),
  loadSecureValue: vi.fn(),
  removeSecureValue: vi.fn(),
}))
vi.mock('@/utils/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import {
  cloneModels,
  cloneProviders,
  resolveProviderSelectedModelId,
  ensureUniqueProviderName,
  assertUniqueProviderNames,
  isMaskedApiKey,
  providerMatchesBackendKey,
  appendLocalProvidersMissingFromRuntime,
  mergeConfigProvidersWithRuntime,
  reconcileDefaultSelection,
  backendToProviders,
  providersToBackend,
  restoreProviderApiKeys,
  materializeProviderApiKeys,
  syncProviderApiKeys,
  resolveDefaultModelProviderId,
} from '@/stores/settings-helpers'

import { saveSecureValue, loadSecureValue, removeSecureValue } from '@/utils/secure-store'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function makeModel(id: string, name?: string, capabilities?: string[]): ModelOption {
  return { id, name: name ?? id, ...(capabilities ? { capabilities } : {}) }
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'Provider1',
    type: 'openai',
    enabled: true,
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test-key',
    models: [makeModel('gpt-4'), makeModel('gpt-3.5')],
    selectedModelId: 'gpt-4',
    ...overrides,
  }
}

function makeBackendConfig(overrides: Partial<BackendLLMConfig> = {}): BackendLLMConfig {
  return {
    default: 'openai',
    providers: {
      openai: { api_key: 'sk-xxx', base_url: 'https://api.openai.com/v1', model: 'gpt-4', compatible: '' },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */
beforeEach(() => {
  vi.clearAllMocks()
})

/* ======================== cloneModels ======================== */
describe('cloneModels', () => {
  it('returns empty array for no arguments', () => {
    expect(cloneModels()).toEqual([])
    expect(cloneModels([])).toEqual([])
  })

  it('clones models and preserves existing capabilities', () => {
    const src: ModelOption[] = [{ id: 'a', name: 'A', capabilities: ['vision', 'text'] }]
    const result = cloneModels(src)

    expect(result).toEqual([{ id: 'a', name: 'A', capabilities: ['vision', 'text'] }])
    // The spread operator shares the capabilities array reference (shallow clone).
    // Verify it at least creates a new model object.
    expect(result[0]).not.toBe(src[0])
  })

  it("defaults capabilities to ['text'] when missing", () => {
    const result = cloneModels([{ id: 'x', name: 'X' }])
    expect(result[0].capabilities).toEqual(['text'])
  })

  it('handles multiple models with mixed capabilities', () => {
    const models: ModelOption[] = [
      { id: 'a', name: 'A', capabilities: ['code'] },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C', capabilities: ['vision', 'audio'] },
    ]
    const result = cloneModels(models)
    expect(result[0].capabilities).toEqual(['code'])
    expect(result[1].capabilities).toEqual(['text'])
    expect(result[2].capabilities).toEqual(['vision', 'audio'])
  })
})

/* ======================== cloneProviders ======================== */
describe('cloneProviders', () => {
  it('returns empty array for no arguments', () => {
    expect(cloneProviders()).toEqual([])
    expect(cloneProviders([])).toEqual([])
  })

  it('deep clones provider list with models', () => {
    const src = [makeProvider()]
    const result = cloneProviders(src)

    // Shallow fields cloned
    expect(result[0].id).toBe('p1')
    expect(result[0].name).toBe('Provider1')

    // Models are deep cloned
    src[0].models.push(makeModel('extra'))
    expect(result[0].models).toHaveLength(2)

    // Capabilities defaulted for models without them
    expect(result[0].models[0].capabilities).toEqual(['text'])
  })

  it('clones multiple providers independently', () => {
    const providers = [
      makeProvider({ id: 'a', name: 'A' }),
      makeProvider({ id: 'b', name: 'B' }),
    ]
    const result = cloneProviders(providers)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('a')
    expect(result[1].id).toBe('b')
  })
})

/* ============== resolveProviderSelectedModelId ============== */
describe('resolveProviderSelectedModelId', () => {
  const provider = {
    models: [makeModel('m1'), makeModel('m2'), makeModel('m3')],
    selectedModelId: 'm2',
  }

  it('returns preferred model id when found in models', () => {
    expect(resolveProviderSelectedModelId(provider, 'm3')).toBe('m3')
  })

  it('trims whitespace on preferred model id', () => {
    expect(resolveProviderSelectedModelId(provider, '  m3  ')).toBe('m3')
  })

  it('falls back to selectedModelId when preferred not found', () => {
    expect(resolveProviderSelectedModelId(provider, 'nonexistent')).toBe('m2')
  })

  it('falls back to selectedModelId when preferred is empty', () => {
    expect(resolveProviderSelectedModelId(provider, '')).toBe('m2')
    expect(resolveProviderSelectedModelId(provider)).toBe('m2')
  })

  it('falls back to first model when selectedModelId not found', () => {
    const p = { models: [makeModel('x1'), makeModel('x2')], selectedModelId: 'gone' }
    expect(resolveProviderSelectedModelId(p, 'also-gone')).toBe('x1')
  })

  it('returns empty string when models is empty', () => {
    expect(resolveProviderSelectedModelId({ models: [], selectedModelId: '' })).toBe('')
    expect(resolveProviderSelectedModelId({ models: [], selectedModelId: 'm2' }, 'nope')).toBe('')
  })

  it('handles undefined selectedModelId', () => {
    const p = { models: [makeModel('a')], selectedModelId: undefined }
    expect(resolveProviderSelectedModelId(p)).toBe('a')
  })
})

/* ============== ensureUniqueProviderName ============== */
describe('ensureUniqueProviderName', () => {
  it("defaults empty name to 'Provider'", () => {
    expect(ensureUniqueProviderName('', [])).toBe('Provider')
    expect(ensureUniqueProviderName('   ', [])).toBe('Provider')
  })

  it('returns trimmed name when already unique', () => {
    const providers = [makeProvider({ name: 'Existing' })]
    expect(ensureUniqueProviderName('NewName', providers)).toBe('NewName')
  })

  it('adds numeric suffix when name collides (case-insensitive)', () => {
    const providers = [makeProvider({ name: 'MyProvider' })]
    expect(ensureUniqueProviderName('myprovider', providers)).toBe('myprovider 2')
  })

  it('increments suffix until unique', () => {
    const providers = [
      makeProvider({ name: 'Foo' }),
      makeProvider({ name: 'Foo 2' }),
      makeProvider({ name: 'Foo 3' }),
    ]
    expect(ensureUniqueProviderName('Foo', providers)).toBe('Foo 4')
  })

  it("defaults empty name to 'Provider' and still deduplicates", () => {
    const providers = [makeProvider({ name: 'Provider' })]
    expect(ensureUniqueProviderName('', providers)).toBe('Provider 2')
  })
})

/* ============== assertUniqueProviderNames ============== */
describe('assertUniqueProviderNames', () => {
  it('passes for no providers', () => {
    expect(() => assertUniqueProviderNames([])).not.toThrow()
  })

  it('passes for unique names', () => {
    expect(() =>
      assertUniqueProviderNames([
        makeProvider({ name: 'Alpha' }),
        makeProvider({ name: 'Beta' }),
      ]),
    ).not.toThrow()
  })

  it('throws on case-insensitive duplicate names', () => {
    expect(() =>
      assertUniqueProviderNames([
        makeProvider({ name: 'OpenAI' }),
        makeProvider({ name: 'openai' }),
      ]),
    ).toThrow(/名称重复/)
  })

  it('skips empty names — no false positives', () => {
    expect(() =>
      assertUniqueProviderNames([
        makeProvider({ name: '' }),
        makeProvider({ name: '' }),
        makeProvider({ name: 'Valid' }),
      ]),
    ).not.toThrow()
  })

  it('skips whitespace-only names', () => {
    expect(() =>
      assertUniqueProviderNames([
        makeProvider({ name: '   ' }),
        makeProvider({ name: '   ' }),
      ]),
    ).not.toThrow()
  })
})

/* ======================== isMaskedApiKey ======================== */
describe('isMaskedApiKey', () => {
  it('returns false for null / undefined / empty string', () => {
    expect(isMaskedApiKey(null)).toBe(false)
    expect(isMaskedApiKey(undefined)).toBe(false)
    expect(isMaskedApiKey('')).toBe(false)
  })

  it('returns true when value contains asterisk', () => {
    expect(isMaskedApiKey('sk-***abc')).toBe(true)
    expect(isMaskedApiKey('****5OsG')).toBe(true)
    expect(isMaskedApiKey('*')).toBe(true)
  })

  it('returns false for clean key', () => {
    expect(isMaskedApiKey('sk-1234567890abcdef')).toBe(false)
    expect(isMaskedApiKey('clean-key-no-stars')).toBe(false)
  })
})

/* ============== providerMatchesBackendKey ============== */
describe('providerMatchesBackendKey', () => {
  const provider = makeProvider({ id: 'p-id-1', backendKey: 'backend-key-1', name: 'MyProvider' })

  it('matches by id', () => {
    expect(providerMatchesBackendKey(provider, 'p-id-1')).toBe(true)
  })

  it('matches by backendKey', () => {
    expect(providerMatchesBackendKey(provider, 'backend-key-1')).toBe(true)
  })

  it('matches by name', () => {
    expect(providerMatchesBackendKey(provider, 'MyProvider')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(providerMatchesBackendKey(provider, 'MYPROVIDER')).toBe(true)
    expect(providerMatchesBackendKey(provider, 'P-ID-1')).toBe(true)
    expect(providerMatchesBackendKey(provider, 'BACKEND-KEY-1')).toBe(true)
  })

  it('trims whitespace', () => {
    expect(providerMatchesBackendKey(provider, '  MyProvider  ')).toBe(true)
  })

  it('returns false for no match', () => {
    expect(providerMatchesBackendKey(provider, 'unknown')).toBe(false)
  })

  it('handles provider without backendKey', () => {
    const p = makeProvider({ id: 'abc', name: 'Test', backendKey: undefined })
    expect(providerMatchesBackendKey(p, 'abc')).toBe(true)
    expect(providerMatchesBackendKey(p, 'Test')).toBe(true)
    expect(providerMatchesBackendKey(p, 'nonexistent')).toBe(false)
  })
})

/* ====== appendLocalProvidersMissingFromRuntime ====== */
describe('appendLocalProvidersMissingFromRuntime', () => {
  it('returns runtime as-is when no local providers', () => {
    const runtime = [makeProvider({ id: 'r1' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, [])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('r1')
  })

  it('appends local providers not present in runtime', () => {
    const runtime = [makeProvider({ id: 'r1', name: 'R1' })]
    const local = [makeProvider({ id: 'l1', name: 'L1' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, local)
    expect(result).toHaveLength(2)
    expect(result[1].id).toBe('l1')
  })

  it('skips local providers already in runtime (matched by id)', () => {
    const runtime = [makeProvider({ id: 'same', name: 'Runtime' })]
    const local = [makeProvider({ id: 'same', name: 'Local' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, local)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Runtime')
  })

  it('skips local providers matched by name against runtime', () => {
    const runtime = [makeProvider({ id: 'r1', name: 'SharedName' })]
    const local = [makeProvider({ id: 'l1', name: 'SharedName' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, local)
    expect(result).toHaveLength(1)
  })

  it('deep clones models in result', () => {
    const runtime = [makeProvider({ id: 'r1' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, [])
    runtime[0].models.push(makeModel('new'))
    expect(result[0].models).toHaveLength(2) // cloneProviders was applied to runtime
  })
})

/* ====== mergeConfigProvidersWithRuntime ====== */
describe('mergeConfigProvidersWithRuntime', () => {
  it('returns config as-is when runtime is empty', () => {
    const config = [makeProvider({ id: 'c1' })]
    const result = mergeConfigProvidersWithRuntime(config, [])
    expect(result).toBe(config) // exact same reference
  })

  it('merges runtime data but preserves config id and enabled', () => {
    const config = [makeProvider({ id: 'c1', name: 'ConfigName', enabled: false, backendKey: 'openai' })]
    const runtime = [makeProvider({ id: 'r1', name: 'RuntimeName', enabled: true, backendKey: 'openai', apiKey: 'runtime-key' })]
    const result = mergeConfigProvidersWithRuntime(config, runtime)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c1')        // config id preserved
    expect(result[0].enabled).toBe(false)   // config enabled preserved
    expect(result[0].apiKey).toBe('runtime-key') // runtime data merged
  })

  it('appends runtime-only providers', () => {
    const config = [makeProvider({ id: 'c1', name: 'C1' })]
    const runtime = [
      makeProvider({ id: 'c1', name: 'C1' }),
      makeProvider({ id: 'r-only', name: 'RuntimeOnly' }),
    ]
    const result = mergeConfigProvidersWithRuntime(config, runtime)
    expect(result).toHaveLength(2)
    expect(result[1].id).toBe('r-only')
  })

  it('does not duplicate when matched by backendKey', () => {
    const config = [makeProvider({ id: 'c1', backendKey: 'deepseek' })]
    const runtime = [makeProvider({ id: 'r1', backendKey: 'deepseek' })]
    const result = mergeConfigProvidersWithRuntime(config, runtime)
    expect(result).toHaveLength(1)
  })

  it('does not duplicate when matched by name', () => {
    const config = [makeProvider({ id: 'c1', name: 'Ollama' })]
    const runtime = [makeProvider({ id: 'r1', name: 'Ollama' })]
    const result = mergeConfigProvidersWithRuntime(config, runtime)
    expect(result).toHaveLength(1)
  })
})

/* ============== resolveDefaultModelProviderId ============== */
describe('resolveDefaultModelProviderId', () => {
  it('returns empty string when modelId is empty', () => {
    expect(resolveDefaultModelProviderId([makeProvider()], '')).toBe('')
  })

  it('returns preferred provider if it has the model', () => {
    const providers = [
      makeProvider({ id: 'a', models: [makeModel('gpt-4')] }),
      makeProvider({ id: 'b', models: [makeModel('gpt-4')] }),
    ]
    expect(resolveDefaultModelProviderId(providers, 'gpt-4', 'b')).toBe('b')
  })

  it('falls back to first provider with model when preferred has no match', () => {
    const providers = [
      makeProvider({ id: 'a', models: [makeModel('m1')] }),
      makeProvider({ id: 'b', models: [makeModel('gpt-4')] }),
    ]
    expect(resolveDefaultModelProviderId(providers, 'gpt-4', 'a')).toBe('b')
  })

  it('returns empty when no provider has the model', () => {
    const providers = [makeProvider({ id: 'a', models: [makeModel('m1')] })]
    expect(resolveDefaultModelProviderId(providers, 'nonexistent')).toBe('')
  })
})

/* ============== reconcileDefaultSelection ============== */
describe('reconcileDefaultSelection', () => {
  it('defaults routing when missing', () => {
    const llm: AppConfig['llm'] = {
      providers: [makeProvider({ id: 'p1', models: [makeModel('gpt-4')], selectedModelId: 'gpt-4' })],
      defaultModel: 'gpt-4',
      defaultProviderId: 'p1',
    }
    reconcileDefaultSelection(llm)
    expect(llm.routing).toEqual({ enabled: false, strategy: 'cost-aware' })
  })

  it('preserves existing routing values', () => {
    const llm: AppConfig['llm'] = {
      providers: [makeProvider({ id: 'p1', models: [makeModel('gpt-4')], selectedModelId: 'gpt-4' })],
      defaultModel: 'gpt-4',
      defaultProviderId: 'p1',
      routing: { enabled: true, strategy: 'round-robin' },
    }
    reconcileDefaultSelection(llm)
    expect(llm.routing).toEqual({ enabled: true, strategy: 'round-robin' })
  })

  it('clears default model when no provider has it', () => {
    const llm: AppConfig['llm'] = {
      providers: [makeProvider({ id: 'p1', models: [makeModel('m1')] })],
      defaultModel: 'nonexistent-model',
      defaultProviderId: 'p1',
    }
    reconcileDefaultSelection(llm)
    expect(llm.defaultModel).toBe('')
    expect(llm.defaultProviderId).toBe('')
  })

  it('updates provider selectedModelId when it is the default provider', () => {
    const llm: AppConfig['llm'] = {
      providers: [
        makeProvider({ id: 'p1', models: [makeModel('m1'), makeModel('m2')], selectedModelId: 'm1' }),
      ],
      defaultModel: 'm2',
      defaultProviderId: 'p1',
    }
    reconcileDefaultSelection(llm)
    expect(llm.providers[0].selectedModelId).toBe('m2')
  })

  it('clears defaultProviderId when no provider found after resolution', () => {
    const llm: AppConfig['llm'] = {
      providers: [],
      defaultModel: 'gpt-4',
      defaultProviderId: 'nonexistent',
    }
    reconcileDefaultSelection(llm)
    expect(llm.defaultModel).toBe('')
    expect(llm.defaultProviderId).toBe('')
  })

  it('resolves defaultModel to selectedModelId when model not in provider', () => {
    const llm: AppConfig['llm'] = {
      providers: [
        makeProvider({ id: 'p1', models: [makeModel('m1'), makeModel('m2')], selectedModelId: 'm1' }),
        makeProvider({ id: 'p2', models: [makeModel('target')], selectedModelId: 'target' }),
      ],
      defaultModel: 'target',
      defaultProviderId: 'p2',
    }
    reconcileDefaultSelection(llm)
    expect(llm.defaultProviderId).toBe('p2')
    expect(llm.defaultModel).toBe('target')
  })
})

/* ======================== backendToProviders ======================== */
describe('backendToProviders', () => {
  it('infers known provider type from key name', () => {
    const backend = makeBackendConfig({
      providers: {
        openai: { api_key: 'sk-1', base_url: '', model: 'gpt-4', compatible: '' },
        anthropic: { api_key: 'sk-2', base_url: '', model: 'claude-sonnet-4-6', compatible: '' },
        deepseek: { api_key: 'sk-3', base_url: '', model: 'deepseek-chat', compatible: '' },
      },
    })
    const result = backendToProviders(backend)

    expect(result.find((p) => p.backendKey === 'openai')!.type).toBe('openai')
    expect(result.find((p) => p.backendKey === 'anthropic')!.type).toBe('anthropic')
    expect(result.find((p) => p.backendKey === 'deepseek')!.type).toBe('deepseek')
  })

  it('falls back to "custom" for unknown type', () => {
    const backend = makeBackendConfig({
      providers: {
        mysteriousLLM: { api_key: 'key', base_url: '', model: 'x', compatible: 'openai' },
      },
    })
    const result = backendToProviders(backend)
    expect(result[0].type).toBe('custom')
  })

  it('merges with local provider data when matched', () => {
    const backend = makeBackendConfig({
      providers: {
        openai: { api_key: 'new-key', base_url: 'https://new-url', model: 'gpt-4', compatible: '' },
      },
    })
    const local = [makeProvider({ id: 'local-id', name: 'openai', type: 'openai', models: [makeModel('gpt-3.5')] })]
    const result = backendToProviders(backend, local)

    // Uses local id and name
    expect(result[0].id).toBe('local-id')
    expect(result[0].name).toBe('openai')
    // Uses backend api_key and base_url
    expect(result[0].apiKey).toBe('new-key')
    expect(result[0].baseUrl).toBe('https://new-url')
    // Merges models — backend model prepended if not in local
    expect(result[0].models.some((m) => m.id === 'gpt-4')).toBe(true)
    expect(result[0].models.some((m) => m.id === 'gpt-3.5')).toBe(true)
  })

  it('sets backendKey on each provider', () => {
    const backend = makeBackendConfig()
    const result = backendToProviders(backend)
    expect(result[0].backendKey).toBe('openai')
  })

  it('resolves selectedModelId from backend model', () => {
    const backend = makeBackendConfig({
      providers: {
        openai: { api_key: '', base_url: '', model: 'gpt-4o', compatible: '' },
      },
    })
    const result = backendToProviders(backend)
    expect(result[0].selectedModelId).toBe('gpt-4o')
  })

  it('handles provider with startsWith match (e.g. "openai-custom" -> openai)', () => {
    const backend = makeBackendConfig({
      providers: {
        'openai-custom': { api_key: '', base_url: '', model: 'x', compatible: '' },
      },
    })
    const result = backendToProviders(backend)
    expect(result[0].type).toBe('openai')
  })
})

/* ======================== providersToBackend ======================== */
describe('providersToBackend', () => {
  it('skips disabled providers', () => {
    const providers = [
      makeProvider({ id: 'a', name: 'A', enabled: false }),
      makeProvider({ id: 'b', name: 'B', enabled: true }),
    ]
    const result = providersToBackend(providers, 'gpt-4')
    expect(Object.keys(result.providers)).toEqual(['B'])
  })

  it('uses backendKey as key, falling back to name then id', () => {
    const providers = [
      makeProvider({ id: 'x', name: 'Y', backendKey: 'bk1' }),
      makeProvider({ id: 'id-only', name: '', backendKey: '' }),
    ]
    const result = providersToBackend(providers, 'gpt-4')
    expect(Object.keys(result.providers)).toContain('bk1')
    expect(Object.keys(result.providers)).toContain('id-only')
  })

  it('sets compatible=openai for custom type', () => {
    const providers = [makeProvider({ type: 'custom', name: 'Custom' })]
    const result = providersToBackend(providers, 'gpt-4')
    expect(result.providers['Custom'].compatible).toBe('openai')
  })

  it('sets compatible="" for known types', () => {
    const providers = [makeProvider({ type: 'openai', name: 'OpenAI' })]
    const result = providersToBackend(providers, 'gpt-4')
    expect(result.providers['OpenAI'].compatible).toBe('')
  })

  it('resolves default provider from defaultProviderId', () => {
    const providers = [
      makeProvider({ id: 'p1', name: 'P1', models: [makeModel('m1')] }),
      makeProvider({ id: 'p2', name: 'P2', models: [makeModel('m2')] }),
    ]
    const result = providersToBackend(providers, 'm2', 'p2')
    expect(result.default).toBe('P2')
  })

  it('falls back to first provider with matching default model', () => {
    const providers = [
      makeProvider({ id: 'p1', name: 'P1', models: [makeModel('m1')] }),
      makeProvider({ id: 'p2', name: 'P2', models: [makeModel('target')], selectedModelId: 'target' }),
    ]
    const result = providersToBackend(providers, 'target', 'nonexistent')
    expect(result.default).toBe('P2')
  })

  it('includes routing and cache in output', () => {
    const result = providersToBackend([makeProvider()], 'gpt-4', '', { enabled: true, strategy: 'round-robin' })
    expect(result.routing).toEqual({ enabled: true, strategy: 'round-robin' })
    expect(result.cache).toEqual({ enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 })
  })

  it('defaults routing strategy to cost-aware', () => {
    const result = providersToBackend([makeProvider()], 'gpt-4', '', { enabled: false, strategy: '' })
    expect(result.routing.strategy).toBe('cost-aware')
  })

  it('sets default to first backend key when no exact match', () => {
    const providers = [makeProvider({ id: 'p1', name: 'P1', models: [makeModel('m1')] })]
    const result = providersToBackend(providers, 'nonexistent-model')
    expect(result.default).toBe('P1')
  })
})

/* ============== restoreProviderApiKeys ============== */
describe('restoreProviderApiKeys', () => {
  it('replaces apiKey from secure store when available', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue('real-secret-key')
    const providers = [makeProvider({ id: 'p1', apiKey: '****mask' })]

    const result = await restoreProviderApiKeys(providers)
    expect(result[0].apiKey).toBe('real-secret-key')
    expect(loadSecureValue).toHaveBeenCalledWith('llm.provider.p1.apiKey')
  })

  it('keeps original apiKey when nothing in secure store', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue(null)
    const providers = [makeProvider({ id: 'p1', apiKey: 'original-key' })]

    const result = await restoreProviderApiKeys(providers)
    expect(result[0].apiKey).toBe('original-key')
  })

  it('returns deep cloned providers', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue(null)
    const src = [makeProvider()]
    const result = await restoreProviderApiKeys(src)

    // Mutating source shouldn't affect result
    src[0].apiKey = 'mutated'
    expect(result[0].apiKey).toBe('sk-test-key')
  })
})

/* ============== materializeProviderApiKeys ============== */
describe('materializeProviderApiKeys', () => {
  it('does not touch non-masked key', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: 'sk-real-key' })]
    const result = await materializeProviderApiKeys(providers)
    expect(result[0].apiKey).toBe('sk-real-key')
    expect(loadSecureValue).not.toHaveBeenCalled()
  })

  it('does not touch empty key', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '' })]
    const result = await materializeProviderApiKeys(providers)
    expect(result[0].apiKey).toBe('')
    expect(loadSecureValue).not.toHaveBeenCalled()
  })

  it('replaces masked key with secure store value', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue('real-secret')
    const providers = [makeProvider({ id: 'p1', apiKey: '****mask' })]

    const result = await materializeProviderApiKeys(providers)
    expect(result[0].apiKey).toBe('real-secret')
  })

  it('throws when masked key has no secure store AND no backendKey', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue(null)
    const providers = [makeProvider({ id: 'p1', name: 'TestProv', apiKey: '****mask', backendKey: undefined })]

    await expect(materializeProviderApiKeys(providers)).rejects.toThrow(/API Key/)
  })

  it('continues silently when masked key has no secure store but has backendKey', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue(null)
    const providers = [makeProvider({ id: 'p1', apiKey: '****mask', backendKey: 'existing-backend' })]

    const result = await materializeProviderApiKeys(providers)
    // Key stays masked — backend will keep the old value
    expect(result[0].apiKey).toBe('****mask')
  })

  it('handles whitespace-only backendKey as missing', async () => {
    vi.mocked(loadSecureValue).mockResolvedValue(null)
    const providers = [makeProvider({ id: 'p1', name: 'X', apiKey: '****mask', backendKey: '   ' })]

    await expect(materializeProviderApiKeys(providers)).rejects.toThrow(/API Key/)
  })
})

/* ============== syncProviderApiKeys ============== */
describe('syncProviderApiKeys', () => {
  it('removes secure keys for deleted providers', async () => {
    const previous = [makeProvider({ id: 'deleted-1' }), makeProvider({ id: 'kept' })]
    const current = [makeProvider({ id: 'kept', apiKey: 'sk-new' })]

    await syncProviderApiKeys(current, previous)
    expect(removeSecureValue).toHaveBeenCalledWith('llm.provider.deleted-1.apiKey')
  })

  it('saves non-masked apiKeys to secure store', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: 'sk-real-key' })]
    await syncProviderApiKeys(providers)
    expect(saveSecureValue).toHaveBeenCalledWith('llm.provider.p1.apiKey', 'sk-real-key')
  })

  it('skips saving masked apiKeys', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '****mask' })]
    await syncProviderApiKeys(providers)
    expect(saveSecureValue).not.toHaveBeenCalled()
  })

  it('removes secure key when provider apiKey is empty', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '' })]
    await syncProviderApiKeys(providers)
    expect(removeSecureValue).toHaveBeenCalledWith('llm.provider.p1.apiKey')
    expect(saveSecureValue).not.toHaveBeenCalled()
  })

  it('handles empty previous providers', async () => {
    const providers = [makeProvider({ id: 'new-one', apiKey: 'key123' })]
    await syncProviderApiKeys(providers, [])
    expect(removeSecureValue).not.toHaveBeenCalled()
    expect(saveSecureValue).toHaveBeenCalledWith('llm.provider.new-one.apiKey', 'key123')
  })

  it('handles whitespace-only apiKey as empty', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '   ' })]
    await syncProviderApiKeys(providers)
    // trimmed to empty → removeSecureValue path
    expect(removeSecureValue).toHaveBeenCalledWith('llm.provider.p1.apiKey')
  })
})
