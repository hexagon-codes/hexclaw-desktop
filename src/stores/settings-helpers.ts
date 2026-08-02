/**
 * Settings store 纯函数helpers — 从 settings.ts 拆出以控制文件体积。
 */

import {
  canonicalizeModelOption,
  cloneModels,
  embeddingContractForModel,
  isChatModelOption,
  mergeProviderModels,
  mergeRemoteModelsIntoProvider,
  normalizeModelCapabilities,
  resolveProviderSelectedModelId,
} from '@/config/model-contract'
import { resolveEffectiveProviderLocality } from '@/utils/provider-endpoint'
import type {
  AppConfig,
  ProviderConfig,
  BackendLLMConfig,
  BackendLLMProvider,
} from '@/types'
import { cloneProviders } from './settings-provider-copy'

export {
  canonicalizeModelOption,
  cloneModels,
  isChatModelOption,
  mergeRemoteModelsIntoProvider,
  normalizeModelCapabilities,
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
    const runtime = runtimeIdentityProviders.find((candidate) =>
      candidate.id === provider.id ||
      Boolean(
        provider.providerInstanceId &&
        candidate.providerInstanceId === provider.providerInstanceId,
      ) ||
      Boolean(candidate.backendKey && providerMatchesBackendKey(provider, candidate.backendKey)),
    )
    if (!runtime) return provider
    return {
      ...provider,
      ...(runtime.providerInstanceId
        ? { providerInstanceId: runtime.providerInstanceId }
        : {}),
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
  ])
}

export function invalidateChangedProviderProbeReceipt(
  previous: ProviderConfig | undefined,
  next: ProviderConfig | undefined,
): void {
  if (
    !previous ||
    !next ||
    !next.probeReceipt ||
    providerProbeConnectivityFingerprint(previous) === providerProbeConnectivityFingerprint(next)
  ) return
  next.probeReceipt = undefined
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
      providers.push({
        ...lp,
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
    if (r) out.push({ ...c, ...r, id: c.id, enabled: c.enabled })
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
  const isOllama = defaultProvider.type === 'ollama' || defaultProvider.name?.toLowerCase().includes('ollama')
  if (isOllama) {
    // 保留用户选择的 defaultModel，不做 provider.models 校验
    defaultProvider.selectedModelId = llmConfig.defaultModel
    return
  }
  defaultProvider.selectedModelId = resolveProviderSelectedModelId(defaultProvider, llmConfig.defaultModel)
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
    const testedAt = typeof rawProbeReceipt?.tested_at === 'number'
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
            ...(rawProbeReceipt.error_code
              ? { errorCode: rawProbeReceipt.error_code }
              : {}),
            ...(rawProbeReceipt.error_message || rawProbeReceipt.message
              ? { errorMessage: rawProbeReceipt.error_message || rawProbeReceipt.message }
              : {}),
          }
        : undefined
    const localProvider =
      (p.provider_instance_id
        ? localProviders.find(
            (provider) => provider.providerInstanceId === p.provider_instance_id,
          )
        : undefined) ??
      localProviders.find((provider) => providerMatchesBackendKey(provider, name))
    const lowerName = name.toLowerCase()
    const matchedType = KNOWN_PROVIDER_TYPES.find((t) => lowerName === t || lowerName.startsWith(t))
    const nextProvider: ProviderConfig = {
      id: localProvider?.id ?? name,
      providerInstanceId: p.provider_instance_id ?? localProvider?.providerInstanceId,
      probeReceipt,
      backendKey: name,
      name: localProvider?.name ?? (p.display_name?.trim() || name),
      type: (localProvider?.type ?? matchedType ?? 'custom') as ProviderConfig['type'],
      // 后端 enabled 缺省/true=启用，false=禁用（还原禁用态，bug 2026-06-22）
      enabled: p.enabled ?? true,
      baseUrl: p.base_url || localProvider?.baseUrl || '',
      apiKey: p.api_key || (p.credential_ref ? '********' : localProvider?.apiKey || ''),
      credentialRef: p.credential_ref,
      credentialPresent: p.credential_present,
      models: mergeProviderModels(localProvider, p.model, p.models, p.model_specs),
      selectedModelId: '',
      modelSpecsMode: p.model_specs_mode ?? 'legacy',
      locality: p.locality ?? localProvider?.locality ?? 'auto',
      localitySource: p.locality_source ?? localProvider?.localitySource,
      confirmedEndpointHost:
        p.confirmed_endpoint_host ?? localProvider?.confirmedEndpointHost,
      privateNetworkAccess:
        p.private_network_access ?? localProvider?.privateNetworkAccess,
      keepAlive: p.keep_alive || localProvider?.keepAlive || '',
      numCtx: p.num_ctx ?? localProvider?.numCtx ?? 0,
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
): BackendLLMConfig {
  const backendProviders: Record<string, BackendLLMProvider> = {}
  for (const p of providers) {
    // 禁用 provider 不再被丢弃：随 enabled:false 上送，后端保留 Key/配置但不参与路由
    // （bug 2026-06-22：此前 `if (!p.enabled) continue` 致禁用即从磁盘删 Key）。
    const key = p.backendKey || p.name || p.id
    // Ollama 模型不在 provider.models 里（来自独立缓存），直接用 defaultModel
    const isOllama = p.type === 'ollama' || p.name?.toLowerCase().includes('ollama')
    const selectedModelId = isOllama && p.id === defaultProviderId
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
        const embedding = embeddingContractForModel(model)
        return {
          id: model.id,
          display_name: model.name || model.id,
          ...(model.isCustom === undefined ? {} : { is_custom: model.isCustom }),
          capabilities: normalizeModelCapabilities(model),
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
      tools_enabled: p.toolsEnabled ?? null,
      max_tools: p.maxTools ?? 0,
      enabled: p.enabled,
      keep_alive: p.keepAlive || '',
      num_ctx: p.numCtx ?? 0,
    }
  }
  // Find which provider the default model belongs to（默认 provider 必须是启用的）
  let defaultProvider = Object.entries(backendProviders).find(
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
    defaultProvider = exactDefaultProvider.backendKey || exactDefaultProvider.name || exactDefaultProvider.id
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
  }
}
