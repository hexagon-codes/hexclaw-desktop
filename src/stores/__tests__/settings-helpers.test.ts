import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderConfig, ModelOption, ModelCapability, BackendLLMConfig, AppConfig } from '@/types'

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */
vi.mock('@/utils/secure-store', () => ({
  credentialPresent: vi.fn().mockResolvedValue(false),
  credentialRefFor: vi.fn((key: { ownerId: string }) => `llm_provider/${key.ownerId}/api_key`),
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
  mergeProviderRuntimeIdentities,
  resolveLoadedDefaultSelection,
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

import { credentialPresent } from '@/utils/secure-store'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function makeModel(id: string, name?: string, capabilities?: ModelCapability[]): ModelOption {
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
    expect(result[0]!.capabilities).toEqual(['text'])
  })

  it('handles multiple models with mixed capabilities', () => {
    const models: ModelOption[] = [
      { id: 'a', name: 'A', capabilities: ['code'] },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C', capabilities: ['vision', 'audio'] },
    ]
    const result = cloneModels(models)
    expect(result[0]!.capabilities).toEqual(['code'])
    expect(result[1]!.capabilities).toEqual(['text'])
    expect(result[2]!.capabilities).toEqual(['vision', 'audio'])
  })

  it('canonicalizes only the two approved OpenRouter embedding ids even when legacy data mislabels them', () => {
    const result = cloneModels([
      { id: 'nvidia/nemotron-3-embed-1b:free', name: 'Nemotron Embed' },
      {
        id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
        name: 'Nemotron Embed VL',
        capabilities: ['text'],
        embedding: { protocol: 'ollama_embeddings', dimension: 7, normalization: 'none' },
      },
      { id: 'acme/embed-chat-pro', name: 'Generic Embed Name' },
      { id: 'acme/embed-chat-explicit', name: 'Generic Explicit Chat', capabilities: ['text'] },
      { id: 'nvidia/nemotron-3-embed-1b', name: 'Near Match Without Free Suffix', capabilities: ['text'] },
      { id: 'proxy/nvidia/nemotron-3-embed-1b:free', name: 'Near Match With Prefix', capabilities: ['text'] },
      { id: 'explicit-empty', name: 'Explicit Empty', capabilities: [] },
    ])

    expect(result[0]!.capabilities).toEqual(['embedding'])
    expect(result[1]!.capabilities).toEqual(['embedding'])
    expect(result[1]!.embedding).toEqual({
      protocol: 'openai_embeddings', dimension: 2048, normalization: 'l2',
    })
    expect(result[2]!.capabilities).toEqual(['text'])
    expect(result[3]!.capabilities).toEqual(['text'])
    expect(result[4]!.capabilities).toEqual(['text'])
    expect(result[5]!.capabilities).toEqual(['text'])
    expect(result[6]!.capabilities).toEqual([])
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
    expect(result[0]!.id).toBe('p1')
    expect(result[0]!.name).toBe('Provider1')

    // Models are deep cloned
    src[0]!.models.push(makeModel('extra'))
    expect(result[0]!.models).toHaveLength(2)

    // Capabilities defaulted for models without them
    expect(result[0]!.models[0]!.capabilities).toEqual(['text'])
  })

  it('clones multiple providers independently', () => {
    const providers = [
      makeProvider({ id: 'a', name: 'A' }),
      makeProvider({ id: 'b', name: 'B' }),
    ]
    const result = cloneProviders(providers)
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('a')
    expect(result[1]!.id).toBe('b')
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

  it('never selects embedding-only or explicitly unclassified models for chat', () => {
    const p = {
      models: [
        makeModel('embed', 'Embed', ['embedding' as ModelCapability]),
        makeModel('unknown', 'Unknown', []),
        makeModel('chat', 'Chat', ['text']),
      ],
      selectedModelId: 'embed',
    }
    expect(resolveProviderSelectedModelId(p, 'embed')).toBe('chat')
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

describe('mergeProviderRuntimeIdentities', () => {
  it('回灌服务端稳定身份但保留本地模型、名称和 API Key', () => {
    const local = makeProvider({
      id: 'local-id',
      name: 'My OpenRouter',
      backendKey: 'openrouter-2',
      apiKey: 'sk-local',
      models: [makeModel('chat-local')],
    })
    const runtime = makeProvider({
      id: 'runtime-id',
      name: 'My OpenRouter',
      backendKey: 'openrouter-2',
      providerInstanceId: 'provider-stable-2',
      apiKey: 'masked',
      models: [makeModel('runtime-model')],
    })

    expect(mergeProviderRuntimeIdentities([local], [runtime])).toEqual([
      {
        ...local,
        backendKey: 'openrouter-2',
        providerInstanceId: 'provider-stable-2',
      },
    ])
  })
})

describe('resolveLoadedDefaultSelection', () => {
  const providers = [
    makeProvider({
      id: 'local',
      name: 'Local',
      backendKey: 'local',
      models: [makeModel('local-chat')],
    }),
    makeProvider({
      id: 'remote',
      name: 'Remote',
      backendKey: 'remote',
      models: [makeModel('remote-chat')],
    }),
  ]
  const backend = makeBackendConfig({
    default: 'remote',
    providers: {
      remote: { api_key: 'masked', base_url: '', model: 'remote-chat', compatible: '' },
    },
  })

  it('优先保留仍有效的本地默认选择', () => {
    expect(resolveLoadedDefaultSelection(providers, backend, 'local-chat', 'local')).toEqual({
      modelId: 'local-chat',
      providerId: 'local',
    })
  })

  it('本地选择失效时回退到仍存在的后端默认', () => {
    expect(resolveLoadedDefaultSelection(providers, backend, 'gone', 'local')).toEqual({
      modelId: 'remote-chat',
      providerId: 'remote',
    })
  })

  it('不会恢复 embedding-only 模型为聊天默认', () => {
    const embeddingProviders = [
      makeProvider({
        id: 'embedding',
        name: 'Embedding',
        backendKey: 'embedding',
        models: [
          {
            id: 'nvidia/nemotron-3-embed-1b:free',
            name: 'Embedding',
            capabilities: ['embedding'],
          },
        ],
      }),
    ]
    const embeddingBackend = makeBackendConfig({
      default: 'embedding',
      providers: {
        embedding: {
          api_key: 'masked',
          base_url: '',
          model: 'nvidia/nemotron-3-embed-1b:free',
          compatible: '',
        },
      },
    })

    expect(
      resolveLoadedDefaultSelection(
        embeddingProviders,
        embeddingBackend,
        'nvidia/nemotron-3-embed-1b:free',
        'embedding',
      ),
    ).toEqual({ modelId: '', providerId: '' })
  })

  it('不会恢复已禁用 Provider 的模型为聊天默认', () => {
    const disabledProviders = [
      makeProvider({
        id: 'disabled',
        name: 'Disabled',
        backendKey: 'disabled',
        enabled: false,
        models: [makeModel('disabled-chat')],
      }),
    ]
    const disabledBackend = makeBackendConfig({
      default: 'disabled',
      providers: {
        disabled: {
          api_key: 'masked',
          base_url: '',
          model: 'disabled-chat',
          compatible: '',
          enabled: false,
        },
      },
    })

    expect(
      resolveLoadedDefaultSelection(
        disabledProviders,
        disabledBackend,
        'disabled-chat',
        'disabled',
      ),
    ).toEqual({ modelId: '', providerId: '' })
  })
})

/* ====== appendLocalProvidersMissingFromRuntime ====== */
describe('appendLocalProvidersMissingFromRuntime', () => {
  it('returns runtime as-is when no local providers', () => {
    const runtime = [makeProvider({ id: 'r1' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, [])
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('r1')
  })

  it('appends local providers not present in runtime', () => {
    const runtime = [makeProvider({ id: 'r1', name: 'R1' })]
    const local = [makeProvider({ id: 'l1', name: 'L1' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, local)
    expect(result).toHaveLength(2)
    expect(result[1]!.id).toBe('l1')
  })

  it('skips local providers already in runtime (matched by id)', () => {
    const runtime = [makeProvider({ id: 'same', name: 'Runtime' })]
    const local = [makeProvider({ id: 'same', name: 'Local' })]
    const result = appendLocalProvidersMissingFromRuntime(runtime, local)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('Runtime')
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
    runtime[0]!.models.push(makeModel('new'))
    expect(result[0]!.models).toHaveLength(2) // cloneProviders was applied to runtime
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
    expect(result[0]!.id).toBe('c1')        // config id preserved
    expect(result[0]!.enabled).toBe(false)   // config enabled preserved
    expect(result[0]!.apiKey).toBe('runtime-key') // runtime data merged
  })

  it('appends runtime-only providers', () => {
    const config = [makeProvider({ id: 'c1', name: 'C1' })]
    const runtime = [
      makeProvider({ id: 'c1', name: 'C1' }),
      makeProvider({ id: 'r-only', name: 'RuntimeOnly' }),
    ]
    const result = mergeConfigProvidersWithRuntime(config, runtime)
    expect(result).toHaveLength(2)
    expect(result[1]!.id).toBe('r-only')
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
    expect(llm.providers[0]!.selectedModelId).toBe('m2')
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
    expect(result[0]!.type).toBe('custom')
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
    expect(result[0]!.id).toBe('local-id')
    expect(result[0]!.name).toBe('openai')
    // Uses backend api_key and base_url
    expect(result[0]!.apiKey).toBe('new-key')
    expect(result[0]!.baseUrl).toBe('https://new-url')
    // Merges models — backend model prepended if not in local
    expect(result[0]!.models.some((m) => m.id === 'gpt-4')).toBe(true)
    expect(result[0]!.models.some((m) => m.id === 'gpt-3.5')).toBe(true)
  })

  it('preserves the frontend id by stable provider identity after the backend key is renamed', () => {
    const providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    const backend = makeBackendConfig({
      providers: {
        'renamed-backend-key': {
          provider_instance_id: providerInstanceId,
          api_key: '****server',
          base_url: 'https://api.example.com/v1',
          model: 'server-model',
          compatible: 'openai',
        },
      },
    })
    const local = [
      makeProvider({
        id: 'frontend-stable-id',
        name: 'Old display name',
        backendKey: 'old-backend-key',
        providerInstanceId,
        apiKey: 'secure-real-key',
      }),
    ]

    const result = backendToProviders(backend, local)

    expect(result[0]!.id).toBe('frontend-stable-id')
    expect(result[0]!.providerInstanceId).toBe(providerInstanceId)
    expect(result[0]!.backendKey).toBe('renamed-backend-key')
  })

  it('sets backendKey on each provider', () => {
    const backend = makeBackendConfig()
    const result = backendToProviders(backend)
    expect(result[0]!.backendKey).toBe('openai')
  })

  it('resolves selectedModelId from backend model', () => {
    const backend = makeBackendConfig({
      providers: {
        openai: { api_key: '', base_url: '', model: 'gpt-4o', compatible: '' },
      },
    })
    const result = backendToProviders(backend)
    expect(result[0]!.selectedModelId).toBe('gpt-4o')
  })

  it('handles provider with startsWith match (e.g. "openai-custom" -> openai)', () => {
    const backend = makeBackendConfig({
      providers: {
        'openai-custom': { api_key: '', base_url: '', model: 'x', compatible: '' },
      },
    })
    const result = backendToProviders(backend)
    expect(result[0]!.type).toBe('openai')
  })

  it('round-trips explicit model_specs without collapsing embedding or [] capabilities', () => {
    const backend = makeBackendConfig({
      providers: {
        openrouter: {
          api_key: '', base_url: '', model: 'chat', compatible: 'openai',
          provider_instance_id: 'provider-stable-01',
          models: ['chat', 'embed', 'unknown'],
          model_specs_mode: 'explicit',
          model_specs: [
            { id: 'chat', display_name: 'Chat', capabilities: ['text'] },
            { id: 'embed', display_name: 'Embed', capabilities: ['embedding'] },
            { id: 'unknown', display_name: 'Unknown', capabilities: [] },
          ],
        },
      },
    })

    const provider = backendToProviders(backend)[0]!
    expect(provider.models).toEqual([
      { id: 'chat', name: 'Chat', capabilities: ['text'] },
      { id: 'embed', name: 'Embed', capabilities: ['embedding'] },
      { id: 'unknown', name: 'Unknown', capabilities: [] },
    ])
    expect(provider.modelSpecsMode).toBe('explicit')
    expect(provider.providerInstanceId).toBe('provider-stable-01')
  })

  it('round-trips the embedding execution contract without synthesizing one for unknown models', () => {
    const backend = makeBackendConfig({
      providers: {
        openrouter: {
          api_key: '', base_url: '', model: 'chat', compatible: 'openai',
          model_specs_mode: 'explicit',
          model_specs: [
            { id: 'chat', display_name: 'Chat', capabilities: ['text'] },
            {
              id: 'nvidia/nemotron-3-embed-1b:free',
              display_name: 'Nemotron Embed',
              capabilities: ['embedding'],
              embedding: { protocol: 'openai_embeddings', dimension: 2048, normalization: 'l2' },
            },
            { id: 'vendor/unknown-vector', display_name: 'Unknown Vector', capabilities: ['embedding'] },
          ],
        },
      },
    })

    const provider = backendToProviders(backend)[0]!
    expect(provider.models[1]!.embedding).toEqual({
      protocol: 'openai_embeddings', dimension: 2048, normalization: 'l2',
    })
    expect(provider.models[2]!.embedding).toBeUndefined()

    const serialized = providersToBackend([provider], 'chat', provider.id)
    expect(serialized.providers.openrouter!.model_specs?.[1]?.embedding).toEqual({
      protocol: 'openai_embeddings', dimension: 2048, normalization: 'l2',
    })
    expect(serialized.providers.openrouter!.model_specs?.[2]?.embedding).toBeUndefined()
  })

  it('keeps ordered models when explicit model_specs is empty or partial', () => {
    const backend = makeBackendConfig({
      providers: {
        empty: {
          api_key: '', base_url: '', model: 'chat', compatible: 'openai',
          models: ['chat', 'vector'], model_specs_mode: 'explicit', model_specs: [],
        },
        partial: {
          api_key: '', base_url: '', model: 'chat', compatible: 'openai',
          models: ['chat', 'unknown'], model_specs_mode: 'explicit',
          model_specs: [{ id: 'chat', display_name: 'Chat', capabilities: ['text'] }],
        },
      },
    })

    const providers = backendToProviders(backend)
    expect(providers.find((provider) => provider.backendKey === 'empty')?.models).toEqual([
      { id: 'chat', name: 'chat', capabilities: [] },
      { id: 'vector', name: 'vector', capabilities: [] },
    ])
    expect(providers.find((provider) => provider.backendKey === 'partial')?.models).toEqual([
      { id: 'chat', name: 'Chat', capabilities: ['text'] },
      { id: 'unknown', name: 'unknown', capabilities: [] },
    ])
  })

  it('treats omitted item capabilities as legacy text but preserves explicit []', () => {
    const backend = makeBackendConfig({
      providers: {
        custom: {
          api_key: '', base_url: '', model: 'legacy-item', compatible: 'openai',
          models: ['legacy-item', 'unclassified'], model_specs_mode: 'explicit',
          model_specs: [
            { id: 'legacy-item', display_name: 'Legacy item' },
            { id: 'unclassified', display_name: 'Unclassified', capabilities: [] },
          ],
        },
      },
    })

    expect(backendToProviders(backend)[0]!.models).toEqual([
      { id: 'legacy-item', name: 'Legacy item', capabilities: ['text'] },
      { id: 'unclassified', name: 'Unclassified', capabilities: [] },
    ])
  })
})

/* ======================== providersToBackend ======================== */
describe('providersToBackend', () => {
  it('includes disabled providers with enabled:false（2026-06-22：禁用≠删除，随 enabled 上送）', () => {
    const providers = [
      makeProvider({ id: 'a', name: 'A', enabled: false }),
      makeProvider({ id: 'b', name: 'B', enabled: true }),
    ]
    const result = providersToBackend(providers, 'gpt-4')
    // 禁用 provider 仍上送（后端据此保留 Key 并跳过路由），不再被丢弃
    expect(Object.keys(result.providers).sort()).toEqual(['A', 'B'])
    expect(result.providers.A!.enabled).toBe(false)
    expect(result.providers.B!.enabled).toBe(true)
    // 默认 provider 不会落到禁用项 A
    expect(result.default).toBe('B')
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
    expect(result.providers['Custom']!.compatible).toBe('openai')
  })

  it('sets compatible="" for known types', () => {
    const providers = [makeProvider({ type: 'openai', name: 'OpenAI' })]
    const result = providersToBackend(providers, 'gpt-4')
    expect(result.providers['OpenAI']!.compatible).toBe('')
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

  it('serializes model_specs and keeps chat default isolated from embedding-only models', () => {
    const provider = makeProvider({
      id: 'openrouter',
      name: 'openrouter',
      backendKey: 'openrouter',
      models: [
        makeModel('embed', 'Embed', ['embedding' as ModelCapability]),
        makeModel('chat', 'Chat', ['text']),
        makeModel('unknown', 'Unknown', []),
      ],
      selectedModelId: 'embed',
    })

    const result = providersToBackend([provider], 'embed', 'openrouter')
    expect(result.providers.openrouter!.model).toBe('chat')
    expect(result.providers.openrouter!.provider_instance_id).toBeUndefined()
    expect(result.providers.openrouter!.model_specs_mode).toBeUndefined()
    expect(result.providers.openrouter!.model_specs).toEqual([
      { id: 'embed', display_name: 'Embed', capabilities: ['embedding'] },
      { id: 'chat', display_name: 'Chat', capabilities: ['text'] },
      { id: 'unknown', display_name: 'Unknown', capabilities: [] },
    ])
  })

  it('sends only a server-issued provider_instance_id and omits a new frontend id', () => {
    const created = makeProvider({ id: 'frontend-uuid', providerInstanceId: undefined })
    const existing = makeProvider({
      id: 'frontend-local-id',
      name: 'Existing',
      backendKey: 'existing',
      providerInstanceId: 'provider-stable-01',
    })

    const result = providersToBackend([created, existing], 'gpt-4', created.id)
    expect(result.providers.Provider1!.provider_instance_id).toBeUndefined()
    expect(result.providers.existing!.provider_instance_id).toBe('provider-stable-01')
  })

  it('serializes the approved OpenRouter embedding models with their exact vector contract', () => {
    const provider = makeProvider({
      id: 'openrouter', name: 'openrouter', backendKey: 'openrouter',
      models: [
        makeModel('chat', 'Chat', ['text']),
        makeModel('nvidia/nemotron-3-embed-1b:free', 'Nemotron Embed', ['text']),
        {
          ...makeModel('nvidia/llama-nemotron-embed-vl-1b-v2:free', 'Nemotron Embed VL', ['vision']),
          embedding: { protocol: 'ollama_embeddings', dimension: 7, normalization: 'none' },
        },
      ],
      selectedModelId: 'chat',
    })

    const specs = providersToBackend([provider], 'chat', provider.id).providers.openrouter!.model_specs!
    expect(specs.slice(1)).toEqual([
      {
        id: 'nvidia/nemotron-3-embed-1b:free', display_name: 'Nemotron Embed',
        capabilities: ['embedding'],
        embedding: { protocol: 'openai_embeddings', dimension: 2048, normalization: 'l2' },
      },
      {
        id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free', display_name: 'Nemotron Embed VL',
        capabilities: ['embedding'],
        embedding: { protocol: 'openai_embeddings', dimension: 2048, normalization: 'l2' },
      },
    ])
  })
})

/* ============== restoreProviderApiKeys ============== */
describe('restoreProviderApiKeys', () => {
  it('keeps plaintext out of renderer and restores only native presence metadata', async () => {
    vi.mocked(credentialPresent).mockResolvedValue(true)
    const providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    const providers = [makeProvider({
      id: 'p1',
      providerInstanceId,
      credentialRef: `llm_provider/${providerInstanceId}/api_key`,
      apiKey: '****mask',
    })]

    const result = await restoreProviderApiKeys(providers)
    expect(result[0]!.apiKey).toBe('********')
    expect(result[0]!.credentialPresent).toBe(true)
    expect(credentialPresent).toHaveBeenCalledWith({
      ownerKind: 'provider',
      ownerId: providerInstanceId,
      secretKind: 'api_key',
    })
  })

  it('keeps original apiKey when no credential ref exists', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: 'original-key' })]

    const result = await restoreProviderApiKeys(providers)
    expect(result[0]!.apiKey).toBe('original-key')
  })

  it('returns deep cloned providers', async () => {
    const src = [makeProvider()]
    const result = await restoreProviderApiKeys(src)

    // Mutating source shouldn't affect result
    src[0]!.apiKey = 'mutated'
    expect(result[0]!.apiKey).toBe('sk-test-key')
  })
})

/* ============== materializeProviderApiKeys ============== */
describe('materializeProviderApiKeys', () => {
  it('does not touch non-masked key', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: 'sk-real-key' })]
    const result = await materializeProviderApiKeys(providers)
    expect(result[0]!.apiKey).toBe('sk-real-key')
    expect(result[0]!.apiKeyMutation).toBe('replace')
  })

  it('does not touch empty key', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '' })]
    const result = await materializeProviderApiKeys(providers)
    expect(result[0]!.apiKey).toBe('')
    expect(result[0]!.apiKeyMutation).toBe('delete')
  })

  it('preserves a masked key without resolving plaintext', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '****mask', backendKey: 'p1' })]

    const result = await materializeProviderApiKeys(providers)
    expect(result[0]!.apiKey).toBe('****mask')
    expect(result[0]!.apiKeyMutation).toBe('preserve')
  })

  it('throws when masked key has no secure store AND no backendKey', async () => {
    const providers = [makeProvider({ id: 'p1', name: 'TestProv', apiKey: '****mask', backendKey: undefined })]

    await expect(materializeProviderApiKeys(providers)).rejects.toThrow(/API Key/)
  })

  it('continues silently when masked key has no secure store but has backendKey', async () => {
    const providers = [makeProvider({ id: 'p1', apiKey: '****mask', backendKey: 'existing-backend' })]

    const result = await materializeProviderApiKeys(providers)
    // Key stays masked — backend will keep the old value
    expect(result[0]!.apiKey).toBe('****mask')
  })

  it('handles whitespace-only backendKey as missing', async () => {
    const providers = [makeProvider({ id: 'p1', name: 'X', apiKey: '****mask', backendKey: '   ' })]

    await expect(materializeProviderApiKeys(providers)).rejects.toThrow(/API Key/)
  })
})

/* ============== syncProviderApiKeys ============== */
describe('syncProviderApiKeys', () => {
  it('fails closed because standalone provider vault mutation is forbidden', async () => {
    await expect(syncProviderApiKeys()).rejects.toThrow('standalone')
  })
})

// ════════════════════════════════════════════════════════════
// BUG-PROVIDER-DISABLE（2026-06-22）：禁用 provider 不再被丢弃，随 enabled 上送/还原
// ════════════════════════════════════════════════════════════
describe('provider enabled 往返（禁用 ≠ 删除 Key）', () => {
  it('providersToBackend 包含禁用 provider 并携带 enabled:false（不再 continue 丢弃）', () => {
    const llm = providersToBackend(
      [
        makeProvider({ id: 'p1', name: 'openai', backendKey: 'openai', enabled: true }),
        makeProvider({ id: 'p2', name: 'deepseek', backendKey: 'deepseek', enabled: false, apiKey: 'sk-deep' }),
      ],
      'gpt-4',
      'p1',
    )
    // 禁用 provider 必须仍在 payload 里（否则后端整表替换删 Key）
    expect(llm.providers.deepseek).toBeDefined()
    expect(llm.providers.deepseek!.enabled).toBe(false)
    expect(llm.providers.openai!.enabled).toBe(true)
    // 默认 provider 不能落到禁用项
    expect(llm.default).toBe('openai')
  })

  it('backendToProviders 还原 enabled:false（GET 回显禁用态）', () => {
    const providers = backendToProviders(
      makeBackendConfig({
        providers: {
          openai: { api_key: '****1234', base_url: '', model: 'gpt-4', compatible: '', enabled: false },
          deepseek: { api_key: '****5678', base_url: '', model: 'deepseek-chat', compatible: '' },
        },
      }),
    )
    const openai = providers.find((p) => p.backendKey === 'openai')
    const deepseek = providers.find((p) => p.backendKey === 'deepseek')
    expect(openai?.enabled).toBe(false) // 后端 enabled:false → 还原禁用
    expect(deepseek?.enabled).toBe(true) // 缺省 → 启用
  })
})
