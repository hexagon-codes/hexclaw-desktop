import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendLLMConfig } from '@/types'

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn(),
  updateLLMConfig: vi.fn(),
  fetchProviderModels: vi.fn(),
  readProviderApiKey: vi.fn(),
}))

import { getLLMConfig, updateLLMConfig } from '@/api/config'
import {
  backendToProviders,
  materializeProviderApiKeys,
  mergeLLMConfigChanges,
  providersToBackend,
} from '@/stores/settings-helpers'
import { createSettingsProviderSync } from '@/stores/settings-provider-sync'

const instanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
const mockGet = vi.mocked(getLLMConfig)
const mockPut = vi.mocked(updateLLMConfig)

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshot(): BackendLLMConfig {
  return {
    config_revision: 10,
    config_digest: 'sha256:baseline',
    default: 'cloud-gpt',
    providers: {
      'cloud-gpt': {
        provider_instance_id: instanceId,
        display_name: 'Cloud GPT',
        api_key: '********',
        api_key_length: 32,
        credential_present: true,
        base_url: 'https://origin.example.test/v1',
        model: 'chat',
        models: ['chat', 'retired'],
        model_specs: [
          { id: 'chat', display_name: 'Chat', capabilities: ['text', 'vision'] },
          { id: 'retired', display_name: 'Retired', capabilities: ['text'] },
        ],
        model_specs_mode: 'explicit',
        compatible: 'openai',
        enabled: true,
        locality: 'cloud',
        locality_source: 'user',
        effective_models: [{ id: 'chat', display_name: 'Chat', capabilities: ['text', 'vision'] }],
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false, similarity: 0.73, ttl: '3h', max_entries: 42 },
    default_reasoning_policy: { mode: 'effort', effort: 'high' },
    reasoning_provider: 'cloud-gpt',
    reasoning_model: 'chat',
  }
}

// 草稿采用设置保存的公共转换，预期结果直接来自独立编辑的业务语义。
function settingsDraft(value: BackendLLMConfig): BackendLLMConfig {
  const providers = backendToProviders(value)
  const selected = providers.find((provider) => provider.backendKey === value.default)
  const result = providersToBackend(
    providers,
    value.providers[value.default]?.model ?? '',
    selected?.id ?? '',
    value.routing,
    value.default_reasoning_policy,
  )
  for (const provider of Object.values(result.providers)) {
    provider.api_key_mutation = { mode: 'preserve' }
  }
  return result
}

function coordinator(initial: BackendLLMConfig) {
  let baseline = copy(initial)
  const record = vi.fn((value: Partial<BackendLLMConfig>) => {
    baseline = { ...baseline, ...copy(value) }
  })
  const sync = createSettingsProviderSync({
    getConfig: () => null,
    getRuntimeProviders: () => [],
    getLLMConfigBaseline: () => baseline,
    getLLMConfigConditions: () => ({
      config_revision: baseline.config_revision,
      config_digest: baseline.config_digest,
    }),
    recordLLMConfigConditions: record,
  })
  return { sync, record, baseline: () => baseline }
}

beforeEach(() => {
  mockGet.mockReset()
  mockPut.mockReset()
  mockPut.mockResolvedValue({ config_revision: 11, config_digest: 'sha256:submitted' })
})

describe('LLM 配置三方合并', () => {
  it('合并外部地址与本地改名和模型删除，稳定实例随服务端键迁移并保留非编辑字段', () => {
    const original = snapshot()
    const draft = settingsDraft(original)
    draft.providers['cloud-gpt']!.display_name = 'Desktop Name'
    draft.providers['cloud-gpt']!.models = ['chat']
    draft.providers['cloud-gpt']!.model_specs = [
      { id: 'chat', display_name: 'Chat', capabilities: ['text', 'vision'] },
    ]
    const current = copy(original)
    const live = current.providers['cloud-gpt']!
    live.base_url = 'https://remote.example.test/v1'
    Object.assign(live, {
      probe_receipt: { outcome: 'passed', provider_instance_id: instanceId },
      model_catalog: [{ id: 'directory-only' }],
    })
    current.providers = { 'cloud-primary': live }
    current.default = 'cloud-primary'
    current.reasoning_provider = 'cloud-primary'
    current.config_revision = 11
    current.config_digest = 'sha256:remote'

    const result = mergeLLMConfigChanges(original, draft, current)

    expect(Object.keys(result.providers)).toEqual(['cloud-primary'])
    expect(result.default).toBe('cloud-primary')
    expect(result.providers['cloud-primary']).toMatchObject({
      provider_instance_id: instanceId,
      display_name: 'Desktop Name',
      base_url: 'https://remote.example.test/v1',
      model: 'chat',
      models: ['chat'],
      model_specs: [{ id: 'chat', display_name: 'Chat', capabilities: ['text', 'vision'] }],
      api_key_mutation: { mode: 'preserve' },
    })
    for (const field of ['api_key', 'api_key_length', 'credential_present', 'effective_models', 'model_specs_mode', 'probe_receipt', 'model_catalog']) {
      expect(result.providers['cloud-primary']).not.toHaveProperty(field)
    }
    expect(result.cache).toEqual({ enabled: false, similarity: 0.73, ttl: '3h', max_entries: 42 })
    expect(result.reasoning_provider).toBe('cloud-primary')
    expect(result.reasoning_model).toBe('chat')
    expect(result.default_reasoning_policy).toEqual({ mode: 'effort', effort: 'high' })
    expect(original.providers['cloud-gpt']!.models).toEqual(['chat', 'retired'])
    expect(draft.providers['cloud-gpt']!.display_name).toBe('Desktop Name')
  })

  it('服务端已删除且本地未改的 Provider 保持删除，本地删除与远端编辑冲突', () => {
    const original = snapshot()
    const draft = settingsDraft(original)
    const remoteRemoved = { ...copy(original), default: '', providers: {} }
    const result = mergeLLMConfigChanges(original, draft, remoteRemoved)
    expect(result.providers).toEqual({})
    expect(result.default).toBe('')

    const localRemoved = { ...draft, default: '', providers: {} }
    const remoteEdited = copy(original)
    remoteEdited.providers['cloud-gpt']!.base_url = 'https://remote.example.test/v1'
    expect(() => mergeLLMConfigChanges(original, localRemoved, remoteEdited)).toThrow('LLM configuration is stale')
    expect(localRemoved.providers).toEqual({})
    expect(remoteEdited.providers['cloud-gpt']!.base_url).toBe('https://remote.example.test/v1')
  })

  it.each(['display_name', 'replace', 'delete'] as const)('保留真实 %s 冲突与两端输入', (change) => {
    const original = snapshot()
    const draft = settingsDraft(original)
    const current = copy(original)
    current.providers['cloud-gpt']!.display_name = 'Remote Name'
    if (change === 'display_name') draft.providers['cloud-gpt']!.display_name = 'Desktop Name'
    else draft.providers['cloud-gpt']!.api_key_mutation = { mode: change }
    const unchangedDraft = copy(draft)
    const unchangedCurrent = copy(current)

    expect(() => mergeLLMConfigChanges(original, draft, current)).toThrow('LLM configuration is stale')
    expect(draft).toEqual(unchangedDraft)
    expect(current).toEqual(unchangedCurrent)
  })

  it('原本无 Key 的常规 delete 标记不会把独立编辑误判为凭据冲突', async () => {
    const original = snapshot()
    const provider = original.providers['cloud-gpt']!
    delete provider.api_key
    delete provider.api_key_length
    provider.credential_present = false
    const local = await materializeProviderApiKeys(backendToProviders(original))
    local[0]!.name = 'Desktop Name'
    const draft = providersToBackend(local, 'chat', local[0]!.id, original.routing, original.default_reasoning_policy)
    expect(draft.providers['cloud-gpt']!.api_key_mutation).toEqual({ mode: 'delete' })
    const current = copy(original)
    current.providers['cloud-gpt']!.base_url = 'https://remote.example.test/v1'

    expect(mergeLLMConfigChanges(original, draft, current).providers['cloud-gpt']).toMatchObject({
      display_name: 'Desktop Name',
      base_url: 'https://remote.example.test/v1',
    })
  })
})

describe('LLM 配置提交协调', () => {
  it('正常提交也保留缓存和推理路由，排队草稿使用入队时基线合并前一项编辑', async () => {
    const initial = snapshot()
    const { sync, baseline } = coordinator(initial)
    const queuedBaseline = baseline()
    const firstOrigin = sync.captureOrigin()
    const secondOrigin = sync.captureOrigin()
    const rename = settingsDraft(initial)
    rename.providers['cloud-gpt']!.display_name = 'Desktop Name'
    const remove = settingsDraft(initial)
    remove.providers['cloud-gpt']!.models = ['chat']
    remove.providers['cloud-gpt']!.model_specs = [
      { id: 'chat', display_name: 'Chat', capabilities: ['text', 'vision'] },
    ]
    let releaseFirst!: () => void
    const firstCompleted = new Promise<void>((resolve) => { releaseFirst = resolve })
    mockPut.mockImplementationOnce(async () => {
      await firstCompleted
      return { config_revision: 11, config_digest: 'sha256:first' }
    }).mockResolvedValueOnce({ config_revision: 12, config_digest: 'sha256:second' })

    const firstJob = sync.enqueue(async () => { await sync.persistLLMConfig(rename, [], firstOrigin) })
    const secondJob = sync.enqueue(async () => { await sync.persistLLMConfig(remove, [], secondOrigin) })
    await vi.waitFor(() => { expect(mockPut).toHaveBeenCalledTimes(1) })
    releaseFirst()
    await Promise.all([firstJob, secondJob])

    expect(mockPut).toHaveBeenCalledTimes(2)
    expect(mockGet).not.toHaveBeenCalled()
    const firstPayload = mockPut.mock.calls[0]![0]
    const secondPayload = mockPut.mock.calls[1]![0]
    expect(firstPayload.cache).toEqual({ enabled: false, similarity: 0.73, ttl: '3h', max_entries: 42 })
    expect(firstPayload.reasoning_provider).toBe('cloud-gpt')
    expect(firstPayload.reasoning_model).toBe('chat')
    expect(secondPayload.providers['cloud-gpt']).toMatchObject({ display_name: 'Desktop Name', models: ['chat'] })
    expect(secondPayload).toMatchObject({ expected_config_revision: 11, expected_config_digest: 'sha256:first' })
    queuedBaseline.providers['cloud-gpt']!.display_name = 'Later Baseline Mutation'
    expect(firstOrigin.baseline?.providers['cloud-gpt']?.display_name).toBe('Cloud GPT')
    expect(secondOrigin.baseline?.providers['cloud-gpt']?.display_name).toBe('Cloud GPT')
    expect(secondOrigin.baseline?.providers['cloud-gpt']?.models).toEqual(['chat', 'retired'])
    expect(baseline().config_revision).toBe(12)
  })

  it.each([
    ['native', 'LLM configuration is stale'],
    ['HTTP code', {
      code: 'UNKNOWN', status: 409,
      message: JSON.stringify({ code: 'LLM_CONFIG_STALE', message: 'LLM configuration is stale' }),
    }],
  ])('仅 %s 明确未提交冲突读回后合并提交一次', async (_label, error) => {
    const initial = snapshot()
    const draft = settingsDraft(initial)
    draft.providers['cloud-gpt']!.display_name = 'Desktop Name'
    const current = copy(initial)
    current.providers['cloud-gpt']!.base_url = 'https://remote.example.test/v1'
    current.config_revision = 11
    current.config_digest = 'sha256:remote'
    mockPut.mockRejectedValueOnce(error).mockResolvedValueOnce({ config_revision: 12, config_digest: 'sha256:merged' })
    mockGet.mockResolvedValue(current)
    const { sync } = coordinator(initial)

    await expect(sync.persistLLMConfig(draft, [], sync.captureOrigin())).resolves.toMatchObject({ config_revision: 12 })

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockPut).toHaveBeenCalledTimes(2)
    expect(mockPut.mock.calls[1]![0]).toMatchObject({
      expected_config_revision: 11,
      expected_config_digest: 'sha256:remote',
      providers: { 'cloud-gpt': { display_name: 'Desktop Name', base_url: 'https://remote.example.test/v1' } },
    })
  })

  it.each([
    ['network unknown', new TypeError('fetch failed')],
    ['native near match', 'Transport error: LLM configuration is stale'],
    ['different HTTP code', {
      code: 'UNKNOWN', status: 409,
      message: JSON.stringify({ code: 'OTHER_CONFLICT', message: 'LLM configuration is stale' }),
    }],
  ])('%s 保留原错误且不读回或重发', async (_label, error) => {
    const initial = snapshot()
    const draft = settingsDraft(initial)
    const { sync } = coordinator(initial)
    mockPut.mockRejectedValueOnce(error)

    const origin = sync.captureOrigin()
    await expect(sync.enqueue(async () => { await sync.persistLLMConfig(draft, [], origin) })).rejects.toBe(error)

    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockGet).not.toHaveBeenCalled()
    if (_label === 'network unknown') {
      const nextDraft = settingsDraft(initial)
      nextDraft.providers['cloud-gpt']!.display_name = 'New Explicit Edit'
      await sync.enqueue(async () => { await sync.persistLLMConfig(nextDraft, [], sync.captureOrigin()) })
    }
    const expectedCount = _label === 'network unknown' ? 2 : 1
    const expectedName = _label === 'network unknown' ? 'New Explicit Edit' : 'Cloud GPT'
    expect(mockPut).toHaveBeenCalledTimes(expectedCount)
    expect(mockPut.mock.calls[expectedCount - 1]![0].providers['cloud-gpt']!.display_name).toBe(expectedName)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('显式替换 Key 遇到 stale 不重发，第二次明确 stale 也不继续提交', async () => {
    const initial = snapshot()
    const { sync } = coordinator(initial)
    const draft = settingsDraft(initial)
    draft.providers['cloud-gpt']!.api_key_mutation = { mode: 'replace' }
    const replacements = [{ providerKey: 'cloud-gpt', secret: 'synthetic-fixture-secret' }]
    mockPut.mockRejectedValueOnce('LLM configuration is stale')
    await expect(sync.persistLLMConfig(draft, replacements, sync.captureOrigin())).rejects.toBe('LLM configuration is stale')
    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockGet).not.toHaveBeenCalled()

    mockPut.mockReset()
    const retryDraft = settingsDraft(initial)
    const current = copy(initial)
    current.config_revision = 11
    current.config_digest = 'sha256:remote'
    mockGet.mockResolvedValue(current)
    mockPut.mockRejectedValueOnce('LLM configuration is stale').mockRejectedValueOnce('LLM configuration is stale')
    await expect(sync.persistLLMConfig(retryDraft, [], sync.captureOrigin())).rejects.toBe('LLM configuration is stale')
    expect(mockPut).toHaveBeenCalledTimes(2)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })
})
