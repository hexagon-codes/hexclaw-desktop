/**
 * Settings store 纯函数helpers — 从 settings.ts 拆出以控制文件体积。
 */

import {
  canonicalizeModelOption,
  cloneModels,
  embeddingContractForModel,
  isChatModelOption,
  invalidateModelNativeReasoning,
  mergeProviderModels,
  mergeRemoteModelsIntoProvider,
  normalizeModelCapabilities,
  normalizeModelReasoningSupport,
  resolveProviderSelectedModelId,
} from '@/config/model-contract'
import { resolveEffectiveProviderLocality } from '@/utils/provider-endpoint'
import { DEFAULT_REASONING_POLICY, normalizeDefaultReasoningPolicy } from '@/utils/reasoning-policy'
import type {
  AppConfig,
  DefaultReasoningPolicy,
  ProviderConfig,
  BackendLLMConfig,
  BackendLLMProvider,
} from '@/types'
import { cloneProviders } from './settings-provider-copy'
import { isMaskedApiKey } from './settings-provider-secrets'

export {
  canonicalizeModelOption,
  cloneModels,
  isChatModelOption,
  mergeRemoteModelsIntoProvider,
  normalizeModelCapabilities,
  normalizeModelReasoningSupport,
  resolveProviderSelectedModelId,
}
export { cloneProviders } from './settings-provider-copy'
export {
  isMaskedApiKey,
  materializeProviderApiKeys,
  providerCredentialReplacements,
  restoreProviderApiKeys,
  syncProviderApiKeys,
} from './settings-provider-secrets'

export const KNOWN_PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'deepseek',
  'qwen',
  'gemini',
  'ark',
  'ollama',
] as const
type KnownProviderType = (typeof KNOWN_PROVIDER_TYPES)[number]

function normalizeProviderName(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase()
}

export function ensureUniqueProviderName(baseName: string, providers: ProviderConfig[]): string {
  const trimmedBaseName = baseName.trim() || 'Provider'
  const usedNames = new Set(
    providers.map((provider) => normalizeProviderName(provider.name)).filter(Boolean),
  )

  if (!usedNames.has(normalizeProviderName(trimmedBaseName))) {
    return trimmedBaseName
  }

  let index = 2
  while (usedNames.has(normalizeProviderName(`${trimmedBaseName} ${index}`))) {
    index += 1
  }
  return `${trimmedBaseName} ${index}`
}

export function assertUniqueProviderNames(providers: ProviderConfig[]) {
  const seen = new Map<string, string>()

  for (const provider of providers) {
    const normalizedName = normalizeProviderName(provider.name)
    if (!normalizedName) continue

    const existingName = seen.get(normalizedName)
    if (existingName) {
      throw new Error(`LLM 服务商名称重复：${provider.name}。请为每个服务商使用唯一名称`)
    }
    seen.set(normalizedName, provider.name)
  }
}

export function providerMatchesBackendKey(provider: ProviderConfig, backendKey: string): boolean {
  const normalizedBackendKey = backendKey.trim().toLowerCase()
  return [provider.id, provider.backendKey, provider.name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.trim().toLowerCase() === normalizedBackendKey)
}

/** 只从服务端快照回灌稳定身份，保留目标配置的展示名、模型和凭据。 */
export function mergeProviderRuntimeIdentities(
  targetProviders: ProviderConfig[],
  runtimeIdentityProviders: ProviderConfig[],
): ProviderConfig[] {
  return targetProviders.map((provider) => {
    const runtime =
      runtimeIdentityProviders.find((candidate) => candidate.id === provider.id) ??
      runtimeIdentityProviders.find(
        (candidate) =>
          Boolean(
            provider.providerInstanceId &&
            candidate.providerInstanceId === provider.providerInstanceId,
          ) ||
          Boolean(
            candidate.backendKey && providerMatchesBackendKey(provider, candidate.backendKey),
          ),
      )
    if (!runtime) return provider
    return {
      ...provider,
      ...(runtime.providerInstanceId ? { providerInstanceId: runtime.providerInstanceId } : {}),
      ...(runtime.backendKey ? { backendKey: runtime.backendKey } : {}),
    }
  })
}

/** 与服务端连接指纹字段保持同一失效边界；展示名不参与。 */
export function providerProbeConnectivityFingerprint(provider: ProviderConfig): string {
  return JSON.stringify([
    provider.type,
    provider.baseUrl.trim().replace(/\/+$/, ''),
    provider.apiKey,
    provider.selectedModelId ?? '',
    provider.locality ?? 'auto',
    provider.privateNetworkAccess?.host ?? '',
    provider.privateNetworkAccess?.allowed ?? false,
    ...(provider.httpAuthorization ? [provider.httpAuthorization] : []),
  ])
}

export function invalidateChangedProviderProbeReceipt(
  previous: ProviderConfig | undefined,
  next: ProviderConfig | undefined,
): void {
  invalidateChangedProviderNativeReasoning(previous, next)
  if (
    !previous ||
    !next ||
    !next.probeReceipt ||
    providerProbeConnectivityFingerprint(previous) === providerProbeConnectivityFingerprint(next)
  )
    return
  next.probeReceipt = undefined
}

/** 原生来源只跟随物理实例、地址和有效 Key，展示名及默认模型不参与。 */
export function invalidateChangedProviderNativeReasoning(
  previous: ProviderConfig | undefined,
  next: ProviderConfig | undefined,
): void {
  if (!previous || !next) return
  const preservesCredential =
    isMaskedApiKey(next.apiKey) &&
    next.apiKeyMutation !== 'delete' &&
    next.credentialRef === previous.credentialRef
  const credentialChanged =
    (next.apiKeyMutation === 'delete' && Boolean(previous.apiKey.trim() || previous.credentialPresent)) ||
    (!preservesCredential && previous.apiKey.trim() !== next.apiKey.trim())
  const sourceChanged =
    previous.providerInstanceId !== next.providerInstanceId ||
    previous.type !== next.type ||
    previous.baseUrl.trim().replace(/\/+$/, '') !== next.baseUrl.trim().replace(/\/+$/, '') ||
    credentialChanged ||
    (Boolean(previous.nativeReasoningSourceFingerprint && next.nativeReasoningSourceFingerprint) &&
      previous.nativeReasoningSourceFingerprint !== next.nativeReasoningSourceFingerprint)
  if (!sourceChanged) return
  next.models = next.models.map(invalidateModelNativeReasoning)
  delete next.nativeReasoningSourceFingerprint
}

/** 后端加载后，在有效的本地选择与后端默认之间确定可恢复的默认模型。 */
export function resolveLoadedDefaultSelection(
  providers: ProviderConfig[],
  backendConfig: BackendLLMConfig,
  persistedModelId: string,
  persistedProviderId: string,
): { modelId: string; providerId: string } {
  const backendModelId = backendConfig.default
    ? backendConfig.providers[backendConfig.default]?.model || ''
    : ''
  const backendProviderId = backendConfig.default
    ? providers.find((provider) => providerMatchesBackendKey(provider, backendConfig.default))
        ?.id || ''
    : ''
  const containsSelection = (providerId: string, modelId: string) =>
    providers.some(
      (provider) =>
        provider.id === providerId &&
        provider.enabled !== false &&
        provider.models.some((model) => model.id === modelId && isChatModelOption(model)),
    )

  if (containsSelection(persistedProviderId, persistedModelId)) {
    return { modelId: persistedModelId, providerId: persistedProviderId }
  }
  if (containsSelection(backendProviderId, backendModelId)) {
    return { modelId: backendModelId, providerId: backendProviderId }
  }
  return { modelId: '', providerId: '' }
}

/** 后端快照中缺失的本地 provider 补回（与 loadLLMFromBackend 逻辑一致） */
export function appendLocalProvidersMissingFromRuntime(
  runtimeSlice: ProviderConfig[],
  localProviders: ProviderConfig[],
): ProviderConfig[] {
  const providers = cloneProviders(runtimeSlice)
  for (const lp of localProviders) {
    if (!providers.some((p) => p.id === lp.id || providerMatchesBackendKey(lp, p.name))) {
      // 独立本地卡片不能继承另一张卡片已占用的后端身份或凭据。
      const identityOwned = runtimeSlice.some(
        (p) =>
          Boolean(lp.providerInstanceId && p.providerInstanceId === lp.providerInstanceId) ||
          Boolean(lp.backendKey && p.backendKey === lp.backendKey),
      )
      providers.push({
        ...lp,
        ...(identityOwned
          ? {
              providerInstanceId: undefined,
              backendKey: undefined,
              credentialRef: undefined,
              credentialPresent: false,
              apiKey: '',
              apiKeyLength: undefined,
              apiKeyMutation: 'delete' as const,
              probeReceipt: undefined,
            }
          : {}),
        models: cloneModels(lp.models),
      })
    }
  }
  return providers
}

/**
 * 以 config 为权威名单，叠加上一次后端同步的 runtime。
 * 避免 saveConfig / getLLMConfig 瞬态少一行时，会话页丢失 Ollama 等仅完整存在于本地的 provider。
 */
export function mergeConfigProvidersWithRuntime(
  configProviders: ProviderConfig[],
  runtimeProviders: ProviderConfig[],
): ProviderConfig[] {
  if (runtimeProviders.length === 0) return configProviders

  const out: ProviderConfig[] = []
  for (const c of configProviders) {
    const r = runtimeProviders.find(
      (x) =>
        x.id === c.id ||
        providerMatchesBackendKey(c, x.backendKey || '') ||
        providerMatchesBackendKey(c, x.name || ''),
    )
    // 配置拥有启用模型名单和选择，旧运行快照不能撤销本次模型编辑。
    if (r) out.push({
      ...c,
      ...r,
      id: c.id,
      enabled: c.enabled,
      models: c.models,
      selectedModelId: c.selectedModelId,
    })
    else out.push(c)
  }
  for (const r of runtimeProviders) {
    if (
      !out.some(
        (o) =>
          o.id === r.id ||
          providerMatchesBackendKey(o, r.backendKey || '') ||
          providerMatchesBackendKey(o, r.name || ''),
      )
    ) {
      out.push(r)
    }
  }
  return out
}

export function resolveDefaultModelProviderId(
  providers: ProviderConfig[],
  modelId: string,
  preferredProviderId = '',
): string {
  if (!modelId) return ''
  const isOllama = (p: ProviderConfig) =>
    p.type === 'ollama' || (p.name?.toLowerCase().includes('ollama') ?? false)
  const holdsModel = (p: ProviderConfig) => {
    const model = p.models.find((candidate) => candidate.id === modelId)
    if (model) return isChatModelOption(model)
    // Ollama keeps its live chat directory outside Provider.models.
    return isOllama(p) && p.models.length === 0
  }
  if (preferredProviderId) {
    const preferred = providers.find((p) => p.id === preferredProviderId)
    // 已禁用的 provider 不能成为默认（与后端 providersToBackend 跳过禁用一致，bug 2026-06-22-J）。
    if (preferred && preferred.enabled !== false && holdsModel(preferred)) {
      return preferred.id
    }
  }
  // 只在启用的 provider 中解析默认，禁用 provider 不参与。
  return providers.find((p) => p.enabled !== false && holdsModel(p))?.id ?? ''
}

export function reconcileDefaultSelection(llmConfig: AppConfig['llm']) {
  llmConfig.routing = {
    enabled: llmConfig.routing?.enabled ?? false,
    strategy: llmConfig.routing?.strategy || 'cost-aware',
  }

  for (const provider of llmConfig.providers) {
    provider.selectedModelId = resolveProviderSelectedModelId(
      provider,
      provider.id === llmConfig.defaultProviderId ? llmConfig.defaultModel : '',
    )
  }

  const resolvedProviderId = resolveDefaultModelProviderId(
    llmConfig.providers,
    llmConfig.defaultModel,
    llmConfig.defaultProviderId ?? '',
  )
  if (!resolvedProviderId) {
    const isOllamaProvider = (p: ProviderConfig) =>
      p.type === 'ollama' || (p.name?.toLowerCase().includes('ollama') ?? false)
    // 仅当默认模型其实存在、只是落在「已禁用」provider 上时，迁移到首个启用 provider
    // （刚禁用持有默认模型的 provider 的场景，bug 2026-06-22-J，与后端 providersToBackend fallback 一致）。
    // 若模型在任何 provider 上都不存在（被删/改名），维持既有「清空」语义。
    const existsOnDisabledOnly = llmConfig.providers.some(
      (p) =>
        p.enabled === false &&
        (isOllamaProvider(p) || p.models.some((m) => m.id === llmConfig.defaultModel)),
    )
    const fallback = existsOnDisabledOnly
      ? llmConfig.providers.find(
          (p) =>
            p.enabled !== false &&
            ((isOllamaProvider(p) && p.models.length === 0) || p.models.some(isChatModelOption)),
        )
      : undefined
    if (fallback) {
      llmConfig.defaultProviderId = fallback.id
      llmConfig.defaultModel = fallback.selectedModelId || fallback.models[0]?.id || ''
    } else {
      llmConfig.defaultProviderId = ''
      llmConfig.defaultModel = ''
    }
    return
  }
  llmConfig.defaultProviderId = resolvedProviderId

  const defaultProvider = llmConfig.providers.find((provider) => provider.id === resolvedProviderId)
  if (!defaultProvider) {
    llmConfig.defaultModel = ''
    llmConfig.defaultProviderId = ''
    return
  }

  // Ollama 模型不在 provider.models 里（来自独立 ollamaModelsCache），跳过模型验证
  const isOllama =
    defaultProvider.type === 'ollama' || defaultProvider.name?.toLowerCase().includes('ollama')
  if (isOllama) {
    // 保留用户选择的 defaultModel，不做 provider.models 校验
    defaultProvider.selectedModelId = llmConfig.defaultModel
    return
  }
  defaultProvider.selectedModelId = resolveProviderSelectedModelId(
    defaultProvider,
    llmConfig.defaultModel,
  )
  if (!defaultProvider.models.some((model) => model.id === llmConfig.defaultModel)) {
    llmConfig.defaultModel = defaultProvider.selectedModelId
  }
}

/** 后端格式 -> 桌面格式 */
export function backendToProviders(
  backend: BackendLLMConfig,
  localProviders: ProviderConfig[] = [],
): ProviderConfig[] {
  return Object.entries(backend.providers).map(([name, p]) => {
    const rawProbeReceipt = (
      p as typeof p & {
        probe_receipt?: {
          provider_instance_id?: string
          outcome?: string
          locality?: string
          latency_ms?: number
          tested_at?: string | number
          error_code?: string
          error_message?: string
          message?: string
        }
      }
    ).probe_receipt
    const testedAt =
      typeof rawProbeReceipt?.tested_at === 'number'
        ? rawProbeReceipt.tested_at
        : Date.parse(rawProbeReceipt?.tested_at ?? '')
    const probeReceipt: ProviderConfig['probeReceipt'] =
      rawProbeReceipt?.provider_instance_id &&
      (rawProbeReceipt.outcome === 'passed' || rawProbeReceipt.outcome === 'failed') &&
      (rawProbeReceipt.locality === 'local' || rawProbeReceipt.locality === 'cloud') &&
      Number.isFinite(testedAt)
        ? {
            providerInstanceId: rawProbeReceipt.provider_instance_id,
            outcome: rawProbeReceipt.outcome as 'passed' | 'failed',
            locality: rawProbeReceipt.locality as 'local' | 'cloud',
            latencyMs: rawProbeReceipt.latency_ms ?? 0,
            testedAt,
            ...(rawProbeReceipt.error_code ? { errorCode: rawProbeReceipt.error_code } : {}),
            ...(rawProbeReceipt.error_message || rawProbeReceipt.message
              ? { errorMessage: rawProbeReceipt.error_message || rawProbeReceipt.message }
              : {}),
          }
        : undefined
    const identityMatches = p.provider_instance_id
      ? localProviders.filter((provider) => provider.providerInstanceId === p.provider_instance_id)
      : []
    const localMatches = identityMatches.length
      ? identityMatches
      : localProviders.filter((provider) => providerMatchesBackendKey(provider, name))
    // 历史多卡误绑定时由服务端明确的展示名确定归属，不能依赖数组先后顺序。
    const namedMatches = localMatches.filter((provider) => provider.name === p.display_name?.trim())
    const localProvider =
      localMatches.length > 1
        ? namedMatches.length === 1
          ? namedMatches[0]
          : undefined
        : localMatches[0]
    if (localMatches.length > 1 && !localProvider) {
      throw new Error('Provider identity is shared by multiple local configurations')
    }
    const lowerName = name.toLowerCase()
    const matchedType = KNOWN_PROVIDER_TYPES.find((t) => lowerName === t || lowerName.startsWith(t))
    const nextProvider: ProviderConfig = {
      id: localProvider?.id ?? name,
      providerInstanceId: p.provider_instance_id ?? localProvider?.providerInstanceId,
      nativeReasoningSourceFingerprint: p.native_reasoning_source_fingerprint,
      probeReceipt,
      backendKey: name,
      name: p.display_name?.trim() || localProvider?.name || name,
      type: (localProvider?.type ?? matchedType ?? 'custom') as ProviderConfig['type'],
      // 后端 enabled 缺省/true=启用，false=禁用（还原禁用态，bug 2026-06-22）
      enabled: p.enabled ?? true,
      baseUrl: p.base_url || localProvider?.baseUrl || '',
      apiKey:
        p.credential_present === false
          ? ''
          : p.api_key || (p.credential_ref ? '********' : localProvider?.apiKey || ''),
      apiKeyLength:
        p.credential_present === false ? 0 : p.api_key_length ?? localProvider?.apiKeyLength,
      credentialRef: p.credential_ref,
      credentialPresent: p.credential_present,
      // effective_models 是 GET 的只读投影；其 capability 与静态声明的路由授权
      // 保持分层，普通保存仍只序列化 ProviderConfig 的声明字段。
      models: mergeProviderModels(
        localProvider && p.native_reasoning_source_fingerprint &&
          localProvider.nativeReasoningSourceFingerprint !== p.native_reasoning_source_fingerprint
          ? { ...localProvider, models: localProvider.models.map(invalidateModelNativeReasoning) }
          : localProvider,
        p.model,
        p.models,
        p.model_specs,
        p.effective_models,
      ),
      selectedModelId: '',
      modelSpecsMode: p.model_specs_mode ?? 'legacy',
      locality: p.locality ?? localProvider?.locality ?? 'auto',
      localitySource: p.locality_source ?? localProvider?.localitySource,
      confirmedEndpointHost: p.confirmed_endpoint_host ?? localProvider?.confirmedEndpointHost,
      privateNetworkAccess: p.private_network_access ?? localProvider?.privateNetworkAccess,
      httpAuthorization: p.http_authorization,
      keepAlive: p.keep_alive || localProvider?.keepAlive || '',
      numCtx: p.num_ctx ?? localProvider?.numCtx ?? 0,
      toolsEnabled: p.tools_enabled === undefined ? localProvider?.toolsEnabled : p.tools_enabled,
      maxTools: p.max_tools ?? localProvider?.maxTools,
    }
    nextProvider.selectedModelId = resolveProviderSelectedModelId(nextProvider, p.model)
    return nextProvider
  })
}

/** 桌面格式 -> 后端格式 */
export function providersToBackend(
  providers: ProviderConfig[],
  defaultModel: string,
  defaultProviderId = '',
  routing = { enabled: false, strategy: 'cost-aware' },
  defaultReasoningPolicy: DefaultReasoningPolicy | undefined = DEFAULT_REASONING_POLICY,
): BackendLLMConfig {
  const backendProviders: Record<string, BackendLLMProvider> = {}
  const providerIdentities = new Set<string>()
  for (const p of providers) {
    // 禁用 provider 不再被丢弃：随 enabled:false 上送，后端保留 Key/配置但不参与路由
    // （bug 2026-06-22：此前 `if (!p.enabled) continue` 致禁用即从磁盘删 Key）。
    const key = p.backendKey || p.name || p.id
    if (
      Object.prototype.hasOwnProperty.call(backendProviders, key) ||
      (p.providerInstanceId && providerIdentities.has(p.providerInstanceId))
    ) {
      throw new Error('Independent providers must not share a backend key or identity')
    }
    if (p.providerInstanceId) providerIdentities.add(p.providerInstanceId)
    // Ollama 模型不在 provider.models 里（来自独立缓存），直接用 defaultModel
    const isOllama = p.type === 'ollama' || p.name?.toLowerCase().includes('ollama')
    const selectedModelId =
      isOllama && p.id === defaultProviderId
        ? defaultModel
        : resolveProviderSelectedModelId(p, p.id === defaultProviderId ? defaultModel : '')
    backendProviders[key] = {
      ...(p.providerInstanceId ? { provider_instance_id: p.providerInstanceId } : {}),
      display_name: p.name,
      ...(p.apiKeyMutation
        ? {
            api_key_mutation: {
              mode: p.apiKeyMutation,
              ...(p.apiKeyMutation === 'replace' && p.credentialRef
                ? { credential_ref: p.credentialRef }
                : {}),
            },
          }
        : {}),
      base_url: p.baseUrl || '',
      model: selectedModelId,
      models: p.models.map((m) => m.id).filter(Boolean),
      model_specs: p.models.map((model) => {
        const canonical = canonicalizeModelOption(model)
        const embedding = embeddingContractForModel(canonical)
        return {
          id: canonical.id,
          display_name: canonical.name || canonical.id,
          ...(canonical.isCustom === undefined ? {} : { is_custom: canonical.isCustom }),
          capabilities: normalizeModelCapabilities(canonical),
          ...(canonical.reasoningSupport === undefined
            ? {}
            : { reasoning_support: normalizeModelReasoningSupport(canonical.reasoningSupport) }),
          ...(canonical.reasoningControl ? { reasoning_control: canonical.reasoningControl } : {}),
          ...(canonical.nativeReasoningSupport === undefined
            ? {}
            : { native_reasoning_support: normalizeModelReasoningSupport(canonical.nativeReasoningSupport) }),
          ...(canonical.nativeReasoningSourceFingerprint
            ? { native_reasoning_source_fingerprint: canonical.nativeReasoningSourceFingerprint }
            : {}),
          ...(embedding ? { embedding } : {}),
        }
      }),
      compatible:
        p.type === 'custom' || !KNOWN_PROVIDER_TYPES.includes(p.type as KnownProviderType)
          ? 'openai'
          : '',
      locality: resolveEffectiveProviderLocality(p),
      locality_source: p.localitySource,
      confirmed_endpoint_host: p.confirmedEndpointHost,
      private_network_access: p.privateNetworkAccess,
      http_authorization: p.httpAuthorization,
      tools_enabled: p.toolsEnabled ?? null,
      max_tools: p.maxTools ?? 0,
      enabled: p.enabled,
      keep_alive: p.keepAlive || '',
      num_ctx: p.numCtx ?? 0,
    }
  }
  // Find which provider the default model belongs to（默认 provider 必须是启用的）
  let defaultProvider =
    Object.entries(backendProviders).find(
      ([, value]) => value.enabled !== false && Boolean(value.model),
    )?.[0] ?? ''
  const exactDefaultProvider = providers.find(
    (provider) =>
      provider.id === defaultProviderId &&
      provider.enabled &&
      provider.models.some((model) => model.id === defaultModel && isChatModelOption(model)),
  )
  if (exactDefaultProvider) {
    // 必须与上面 backendProviders 的键解析一致（backendKey 优先），否则 backendKey≠name 时
    // default 指向 providers map 不存在的键（后端 router 自愈到首个，但前端是真错）。
    defaultProvider =
      exactDefaultProvider.backendKey || exactDefaultProvider.name || exactDefaultProvider.id
  } else {
    for (const [key, val] of Object.entries(backendProviders)) {
      if (val.enabled === false) continue // 默认 provider 不能落到禁用项
      if (val.model === defaultModel) {
        defaultProvider = key
        break
      }
    }
  }
  return {
    default: defaultProvider,
    providers: backendProviders,
    routing: {
      enabled: routing.enabled,
      strategy: routing.strategy || 'cost-aware',
    },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    default_reasoning_policy: normalizeDefaultReasoningPolicy(defaultReasoningPolicy),
  }
}

/** 按原基线合并独立编辑；同字段冲突保留草稿，不覆盖当前服务端配置。 */
export function mergeLLMConfigChanges(
  baseline: BackendLLMConfig,
  draft: BackendLLMConfig,
  current: BackendLLMConfig,
): BackendLLMConfig {
  // 只比较设置页可编辑的同形投影；输出保留服务端的原始配置及非编辑字段。
  const project = (value: BackendLLMConfig) => {
    const providers = backendToProviders(value)
    const selected = providers.find((provider) => provider.backendKey === value.default)
    return providersToBackend(
      providers,
      value.providers[value.default]?.model ?? '',
      selected?.id ?? '',
      value.routing,
      value.default_reasoning_policy,
    )
  }
  const original = project(baseline)
  const latest = project(current)
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]))
    }
    return value
  }
  const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
  const conflict = () => { throw new Error('LLM configuration is stale') }
  const merge = <T>(before: T, requested: T, live: T): T => {
    if (equal(requested, before)) return live
    if (equal(live, before) || equal(requested, live)) return requested
    return conflict()
  }
  const identity = (key: string, provider: BackendLLMConfig['providers'][string]) =>
    provider.provider_instance_id ? `instance:${provider.provider_instance_id}` : `key:${key}`
  const index = (value: BackendLLMConfig) => new Map(Object.entries(value.providers)
    .map(([key, provider]) => {
      const comparable = { ...provider }
      delete comparable.api_key_mutation
      return [identity(key, provider), { key, provider: comparable }]
    }))
  const beforeById = index(original)
  const requestedById = index(draft)
  const currentById = index(latest)
  const result: BackendLLMConfig = JSON.parse(JSON.stringify(current))
  result.providers = {}
  const groups = [
    ['base_url', 'locality', 'locality_source', 'confirmed_endpoint_host', 'private_network_access', 'http_authorization'],
    ['model', 'models', 'model_specs'],
    ['display_name'], ['compatible'], ['tools_enabled'], ['max_tools'], ['enabled'], ['keep_alive'], ['num_ctx'],
  ] as const
  const stripReadOnly = (provider: BackendLLMConfig['providers'][string]) => {
    const copy: BackendLLMProvider = {
      base_url: provider.base_url, model: provider.model, compatible: provider.compatible,
      ...Object.fromEntries(['provider_instance_id', ...groups.flat()].flatMap((field) =>
        provider[field as keyof typeof provider] === undefined ? [] : [[field, provider[field as keyof typeof provider]]],
      )),
    }
    copy.api_key_mutation = { mode: 'preserve' }
    return copy
  }
  for (const id of new Set([...beforeById.keys(), ...requestedById.keys(), ...currentById.keys()])) {
    const before = beforeById.get(id)
    const requested = requestedById.get(id)
    const live = currentById.get(id)
    if (!before || !requested || !live) {
      const entry = merge(before, requested, live)
      if (entry) {
        const raw = live && entry === live ? current.providers[live.key]! : entry.provider
        if (result.providers[entry.key]) conflict()
        result.providers[entry.key] = stripReadOnly(raw)
      }
      continue
    }
    // 脱敏 GET 无法证明凭据没有被另一客户端轮换，显式改 Key 不自动覆盖。
    const mutation = draft.providers[requested.key]?.api_key_mutation
    const originalCredential = baseline.providers[before.key]!
    const hadCredential = originalCredential.credential_present !== false &&
      !!(originalCredential.credential_ref || originalCredential.api_key)
    if (mutation?.mode === 'replace' || (mutation?.mode === 'delete' && hadCredential)) conflict()
    const merged = stripReadOnly(current.providers[live.key]!)
    for (const fields of groups) {
      const beforeValues = fields.map((field) => before.provider[field])
      const requestedValues = fields.map((field) => requested.provider[field])
      const currentValues = fields.map((field) => live.provider[field])
      const values = merge(beforeValues, requestedValues, currentValues)
      if (values === currentValues) continue
      fields.forEach((field, position) => {
        if (values[position] === undefined) delete merged[field]
        else Object.assign(merged, { [field]: values[position] })
      })
    }
    if (result.providers[live.key]) conflict()
    result.providers[live.key] = merged
  }
  const defaultIdentity = (value: BackendLLMConfig) => {
    const provider = value.providers[value.default]
    return provider ? identity(value.default, provider) : ''
  }
  const selectedIdentity = merge(defaultIdentity(original), defaultIdentity(draft), defaultIdentity(latest))
  result.default = Object.entries(result.providers).find(([key, provider]) => identity(key, provider) === selectedIdentity)?.[0] ?? ''
  if (selectedIdentity && !result.default) conflict()
  result.routing = {
    enabled: merge(original.routing.enabled, draft.routing.enabled, latest.routing.enabled),
    strategy: merge(original.routing.strategy, draft.routing.strategy, latest.routing.strategy),
  }
  result.default_reasoning_policy = merge(original.default_reasoning_policy, draft.default_reasoning_policy, latest.default_reasoning_policy)
  delete result.expected_config_revision
  delete result.expected_config_digest
  return result
}

/** 将最近一次 GET 的完整非敏感版本快照附加到一次配置写入。 */
export function withLLMConfigConditions(
  backendConfig: BackendLLMConfig,
  snapshot: Pick<BackendLLMConfig, 'config_revision' | 'config_digest'> | null | undefined,
): BackendLLMConfig {
  const revision = snapshot?.config_revision
  const digest = snapshot?.config_digest?.trim()
  if (!Number.isSafeInteger(revision) || (revision ?? -1) < 0 || !digest) {
    return backendConfig
  }
  return {
    ...backendConfig,
    expected_config_revision: revision,
    expected_config_digest: digest,
  }
}
