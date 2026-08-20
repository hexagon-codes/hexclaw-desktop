import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  BackendLLMConfig,
  BackendProviderModelSpec,
  ModelOption,
  ModelReasoningSupport,
  ProviderConfig,
} from '@/types'
import { backendToProviders, providersToBackend } from '@/stores/settings-helpers'
import {
  canonicalizeModelOption,
  mergeProviderModels,
  normalizeModelReasoningSupport,
} from '@/config/model-contract'

const mockGetLLMConfig = vi.hoisted(() => vi.fn())
const mockUpdateLLMConfig = vi.hoisted(() => vi.fn())
const mockGetOllamaStatus = vi.hoisted(() => vi.fn())

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: (config: unknown) => mockUpdateLLMConfig(config),
  fetchProviderModels: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() {
      return null
    }

    async set() {}

    async save() {}

    async delete() {}
  }

  return { LazyStore: MockLazyStore }
})

type ReasoningModelOption = ModelOption & {
  reasoningSupport?: ModelReasoningSupport
  reasoningControl?: {
    dialect: 'reasoning_effort' | 'enable_thinking' | 'think' | 'thinking'
    on: unknown
    off: unknown
    allowed_efforts?: readonly string[]
  }
}

type ReasoningBackendModelSpec = BackendProviderModelSpec & {
  reasoning_support?: ModelReasoningSupport
  reasoning_control?: ReasoningModelOption['reasoningControl']
}

function reasoningSupportOf(value: unknown): ModelReasoningSupport | undefined {
  return (value as { reasoningSupport?: ModelReasoningSupport }).reasoningSupport
}

function reasoningControlOf(value: unknown): ReasoningModelOption['reasoningControl'] {
  return (value as ReasoningModelOption).reasoningControl
}

const effortControl: NonNullable<ReasoningModelOption['reasoningControl']> = {
  dialect: 'reasoning_effort',
  on: 'high',
  off: 'none',
  allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}

function makeProvider(
  models: ReasoningModelOption[],
  type: ProviderConfig['type'] = 'custom',
): ProviderConfig {
  return {
    id: 'provider-1',
    backendKey: 'provider',
    name: 'Provider',
    type,
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    models,
    selectedModelId: models[0]?.id,
  }
}

function ollamaBackendConfig(): BackendLLMConfig {
  return {
    default: 'ollama',
    providers: {
      ollama: {
        base_url: 'http://localhost:11434/v1',
        model: 'plain-chat:latest',
        compatible: '',
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10_000 },
  }
}

async function setupOllamaStore() {
  mockGetLLMConfig.mockResolvedValue(ollamaBackendConfig())
  mockGetOllamaStatus.mockResolvedValue({
    running: false,
    associated: false,
    model_count: 0,
    models: [],
  })

  const { useSettingsStore } = await import('../settings')
  const store = useSettingsStore()
  await store.loadConfig()
  return store
}

describe('model reasoning support contract', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockReset()
    mockUpdateLLMConfig.mockReset()
    mockUpdateLLMConfig.mockResolvedValue({})
    mockGetOllamaStatus.mockReset()
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
  })

  it('defines exactly supported, unsupported and unknown', () => {
    expectTypeOf<ModelReasoningSupport>().toEqualTypeOf<'supported' | 'unsupported' | 'unknown'>()

    const states = [
      'supported',
      'unsupported',
      'unknown',
    ] as const satisfies readonly ModelReasoningSupport[]
    const normalized = states.map((reasoningSupport) =>
      reasoningSupportOf(
        canonicalizeModelOption({
          id: `model-${reasoningSupport}`,
          name: reasoningSupport,
          reasoningSupport,
          ...(reasoningSupport === 'supported' ? { reasoningControl: effortControl } : {}),
        } as ReasoningModelOption),
      ),
    )

    expect(normalized).toEqual(states)
    expect(
      reasoningSupportOf(
        canonicalizeModelOption({
          id: 'invalid-state',
          name: 'Invalid state',
          reasoningSupport: 'enabled',
        } as unknown as ReasoningModelOption),
      ),
    ).toBe('unknown')
  })

  it('normalizes legacy models without the field to unknown', () => {
    const localModel = canonicalizeModelOption({ id: 'legacy-local', name: 'Legacy local' })
    const [backendModel] = mergeProviderModels(
      undefined,
      'legacy-backend',
      ['legacy-backend'],
      [{ id: 'legacy-backend', display_name: 'Legacy backend' }],
    )

    expect.soft(normalizeModelReasoningSupport(reasoningSupportOf(localModel))).toBe('unknown')
    expect.soft(normalizeModelReasoningSupport(reasoningSupportOf(backendModel))).toBe('unknown')
  })

  it('round-trips reasoning_support through BackendProviderModelSpec', () => {
    const states = [
      'supported',
      'unsupported',
      'unknown',
    ] as const satisfies readonly ModelReasoningSupport[]
    const provider = makeProvider(
      states.map((reasoningSupport) => ({
        id: `model-${reasoningSupport}`,
        name: reasoningSupport,
        capabilities: ['text'],
        reasoningSupport,
        ...(reasoningSupport === 'supported' ? { reasoningControl: effortControl } : {}),
      })),
    )

    const backend = providersToBackend([provider], provider.models[0]!.id, provider.id)
    const backendSpecs = backend.providers.provider!.model_specs as ReasoningBackendModelSpec[]
    expect.soft(backendSpecs.map((spec) => spec.reasoning_support)).toEqual(states)

    const restored = backendToProviders(backend)[0]!.models
    expect.soft(restored.map(reasoningSupportOf)).toEqual(states)
    expect.soft(reasoningControlOf(restored[0])).toEqual(effortControl)
    expect.soft(reasoningControlOf(restored[1])).toBeUndefined()
    expect.soft(reasoningControlOf(restored[2])).toBeUndefined()
  })

  it('round-trips each exact dialect without leaking it across model switches', () => {
    const controls: NonNullable<ReasoningModelOption['reasoningControl']>[] = [
      effortControl,
      { dialect: 'enable_thinking', on: true, off: false },
      { dialect: 'think', on: true, off: false },
      {
        dialect: 'thinking',
        on: { type: 'enabled', budget_tokens: 1024 },
        off: { type: 'disabled' },
      },
    ]
    const provider = makeProvider(
      controls.map((reasoningControl, index) => ({
        id: `exact-model-${index}`,
        name: `Exact model ${index}`,
        capabilities: ['text'],
        reasoningSupport: 'supported',
        reasoningControl,
      })),
    )

    const backend = providersToBackend([provider], provider.models[0]!.id, provider.id)
    const backendSpecs = backend.providers.provider!.model_specs as ReasoningBackendModelSpec[]
    expect.soft(backendSpecs.map((spec) => spec.reasoning_control)).toEqual(controls)

    const restored = backendToProviders(backend)[0]!.models
    expect.soft(restored.map(reasoningControlOf)).toEqual(controls)
    expect.soft(restored[1]!.reasoningControl).not.toEqual(restored[0]!.reasoningControl)
  })

  it('restores only a same-ID exact preset when an upgraded backend spec omits both reasoning fields', () => {
    const localPresetProvider = makeProvider([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        capabilities: ['text', 'vision'],
        reasoningSupport: 'supported',
        reasoningControl: effortControl,
      },
    ], 'openai')

    const omitted = mergeProviderModels(
      localPresetProvider,
      'gpt-5.6-sol',
      ['gpt-5.6-sol'],
      [{ id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', capabilities: ['text', 'vision'] }],
    )[0]
    const explicitUnknown = mergeProviderModels(
      localPresetProvider,
      'gpt-5.6-sol',
      ['gpt-5.6-sol'],
      [{
        id: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        capabilities: ['text', 'vision'],
        reasoning_support: 'unknown',
      }],
    )[0]
    const explicitControl = mergeProviderModels(
      localPresetProvider,
      'gpt-5.6-sol',
      ['gpt-5.6-sol'],
      [{
        id: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        capabilities: ['text', 'vision'],
        reasoning_control: { dialect: 'think', on: true, off: false },
      }],
    )[0]

    expect(reasoningSupportOf(omitted)).toBe('supported')
    expect(reasoningControlOf(omitted)).toEqual(effortControl)
    expect(reasoningSupportOf(explicitUnknown)).toBe('unknown')
    expect(reasoningControlOf(explicitUnknown)).toBeUndefined()
    expect(reasoningSupportOf(explicitControl)).toBe('unknown')
    expect(reasoningControlOf(explicitControl)).toBeUndefined()
  })

  it('accepts allowed_efforts only as an exact reasoning_effort declaration', () => {
    const valid = canonicalizeModelOption({
      id: 'effort-only',
      name: 'Effort only',
      reasoningSupport: 'supported',
      reasoningControl: effortControl,
    } as ReasoningModelOption)
    const invalidDuplicate = canonicalizeModelOption({
      id: 'duplicate-effort',
      name: 'Duplicate effort',
      reasoningSupport: 'supported',
      reasoningControl: {
        dialect: 'reasoning_effort',
        on: 'high',
        off: 'none',
        allowed_efforts: ['low', 'high', 'high'],
      },
    } as ReasoningModelOption)
    const invalidBoolean = canonicalizeModelOption({
      id: 'boolean-effort',
      name: 'Boolean effort',
      reasoningSupport: 'supported',
      reasoningControl: {
        dialect: 'think',
        on: true,
        off: false,
        allowed_efforts: ['high'],
      },
    } as ReasoningModelOption)

    expect.soft(reasoningControlOf(valid)).toEqual(effortControl)
    expect.soft(reasoningSupportOf(invalidDuplicate)).toBe('unknown')
    expect.soft(reasoningSupportOf(invalidBoolean)).toBe('unknown')
  })

  it('fails closed when support and control declarations are inconsistent', () => {
    const supportedWithoutControl = canonicalizeModelOption({
      id: 'supported-without-control',
      name: 'Supported without control',
      reasoningSupport: 'supported',
    } as ReasoningModelOption)
    const unsupportedWithControl = canonicalizeModelOption({
      id: 'unsupported-with-control',
      name: 'Unsupported with control',
      reasoningSupport: 'unsupported',
      reasoningControl: { dialect: 'think', on: true, off: false },
    } as ReasoningModelOption)

    expect.soft(reasoningSupportOf(supportedWithoutControl)).toBe('unknown')
    expect.soft(reasoningControlOf(supportedWithoutControl)).toBeUndefined()
    expect.soft(reasoningSupportOf(unsupportedWithControl)).toBe('unknown')
    expect.soft(reasoningControlOf(unsupportedWithControl)).toBeUndefined()
  })

  it('maps Ollama capability evidence to supported, unsupported and unknown', async () => {
    const store = await setupOllamaStore()
    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 3,
      models: [
        {
          name: 'plain-chat:latest',
          size: 1,
          capabilities: ['completion', 'thinking'],
        },
        {
          name: 'deepseek-r1-thinking:latest',
          size: 1,
          capabilities: ['completion'],
        },
        {
          name: 'qwen-thinking-name-only:latest',
          size: 1,
        },
      ],
    })

    await store.syncOllamaModels()

    const supports = new Map(
      store.availableModels.map((model) => [model.modelId, reasoningSupportOf(model)]),
    )
    expect.soft(supports.get('plain-chat:latest')).toBe('supported')
    expect.soft(supports.get('deepseek-r1-thinking:latest')).toBe('unsupported')
    expect.soft(supports.get('qwen-thinking-name-only:latest')).toBe('unknown')
    const supported = store.availableModels.find((model) => model.modelId === 'plain-chat:latest')
    expect(reasoningControlOf(supported)).toEqual({ dialect: 'think', on: true, off: false })
  })

  it('never infers reasoning support from a model id', () => {
    const ids = ['o1-pro', 'deepseek-r1', 'qwen3-thinking', 'claude-extended-thinking']
    const results = ids.map((id) => normalizeModelReasoningSupport(
      reasoningSupportOf(canonicalizeModelOption({ id, name: id })),
    ))

    expect(results).toEqual(ids.map(() => 'unknown'))
  })
})
