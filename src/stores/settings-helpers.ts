/**
 * Settings store 纯函数helpers — 从 settings.ts 拆出以控制文件体积。
 */

import { loadSecureValue, removeSecureValue, saveSecureValue } from '@/utils/secure-store'
import type {
  AppConfig,
  ProviderConfig,
  ModelOption,
  BackendLLMConfig,
  BackendLLMProvider,
} from '@/types'

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

export function cloneModels(models: ModelOption[] = []): ModelOption[] {
  return models.map((model) => ({
    ...model,
    capabilities: model.capabilities ?? ['text'],
  }))
}

export function cloneProviders(providers: ProviderConfig[] = []): ProviderConfig[] {
  return providers.map((provider) => ({
    ...provider,
    models: cloneModels(provider.models),
  }))
}

export function resolveProviderSelectedModelId(
  provider: Pick<ProviderConfig, 'models' | 'selectedModelId'>,
  preferredModelId = '',
): string {
  const trimmedPreferredModelId = preferredModelId.trim()
  if (
    trimmedPreferredModelId &&
    provider.models.some((model) => model.id === trimmedPreferredModelId)
  ) {
    return trimmedPreferredModelId
  }

  const currentSelectedModelId = provider.selectedModelId?.trim() ?? ''
  if (currentSelectedModelId && provider.models.some((model) => model.id === currentSelectedModelId)) {
    return currentSelectedModelId
  }

  return provider.models[0]?.id ?? ''
}

function secureApiKeyKey(providerId: string): string {
  return `llm.provider.${providerId}.apiKey`
}

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

export function isMaskedApiKey(value: string | undefined | null): boolean {
  return (value ?? '').includes('*')
}

export function providerMatchesBackendKey(provider: ProviderConfig, backendKey: string): boolean {
  const normalizedBackendKey = backendKey.trim().toLowerCase()
  return [provider.id, provider.backendKey, provider.name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.trim().toLowerCase() === normalizedBackendKey)
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

function mergeProviderModels(
  localProvider: ProviderConfig | undefined,
  backendModelId: string,
): ModelOption[] {
  const localModels = cloneModels(localProvider?.models ?? [])
  const trimmedBackendModelId = backendModelId.trim()

  if (!trimmedBackendModelId) return localModels
  if (localModels.some((model) => model.id === trimmedBackendModelId)) return localModels

  return [
    {
      id: trimmedBackendModelId,
      name: trimmedBackendModelId,
      capabilities: ['text'],
    },
    ...localModels,
  ]
}

export function resolveDefaultModelProviderId(
  providers: ProviderConfig[],
  modelId: string,
  preferredProviderId = '',
): string {
  if (!modelId) return ''
  if (preferredProviderId) {
    const preferred = providers.find((p) => p.id === preferredProviderId)
    if (preferred) {
      // Ollama 模型不在 provider.models 里，信任 preferredProviderId
      const isOllama = preferred.type === 'ollama' || preferred.name?.toLowerCase().includes('ollama')
      if (isOllama || preferred.models.some((model) => model.id === modelId)) {
        return preferred.id
      }
    }
  }
  return (
    providers.find((provider) => provider.models.some((model) => model.id === modelId))?.id ?? ''
  )
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
  llmConfig.defaultProviderId = resolvedProviderId
  if (!resolvedProviderId) {
    llmConfig.defaultModel = ''
    return
  }

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

export async function restoreProviderApiKeys(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  const restoredProviders = cloneProviders(providers)

  for (const provider of restoredProviders) {
    const secureApiKey = await loadSecureValue(secureApiKeyKey(provider.id))
    if (secureApiKey) {
      provider.apiKey = secureApiKey
    }
  }

  return restoredProviders
}

export async function materializeProviderApiKeys(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  const normalizedProviders = cloneProviders(providers)

  for (const provider of normalizedProviders) {
    const currentApiKey = provider.apiKey.trim()
    if (!currentApiKey) continue
    if (!isMaskedApiKey(currentApiKey)) continue

    const secureApiKey = await loadSecureValue(secureApiKeyKey(provider.id))
    if (!secureApiKey) {
      if (provider.backendKey?.trim()) {
        // 已存在于后端的 provider 可以继续回传脱敏值，让后端保留旧 Key。
        continue
      }
      throw new Error(
        `服务商 ${provider.name || provider.id} 的 API Key 只有脱敏值，请重新输入完整 Key 后再保存`,
      )
    }
    provider.apiKey = secureApiKey
  }

  return normalizedProviders
}

export async function syncProviderApiKeys(
  providers: ProviderConfig[],
  previousProviders: ProviderConfig[] = [],
): Promise<void> {
  const nextProviderIds = new Set(providers.map((provider) => provider.id))

  for (const previousProvider of previousProviders) {
    if (!nextProviderIds.has(previousProvider.id)) {
      await removeSecureValue(secureApiKeyKey(previousProvider.id))
    }
  }

  for (const provider of providers) {
    const apiKey = provider.apiKey.trim()
    if (!apiKey) {
      await removeSecureValue(secureApiKeyKey(provider.id))
      continue
    }
    if (isMaskedApiKey(apiKey)) continue
    await saveSecureValue(secureApiKeyKey(provider.id), apiKey)
  }
}

/** 后端格式 -> 桌面格式 */
export function backendToProviders(
  backend: BackendLLMConfig,
  localProviders: ProviderConfig[] = [],
): ProviderConfig[] {
  return Object.entries(backend.providers).map(([name, p]) => {
    const localProvider = localProviders.find((provider) =>
      providerMatchesBackendKey(provider, name),
    )
    const lowerName = name.toLowerCase()
    const matchedType = KNOWN_PROVIDER_TYPES.find((t) => lowerName === t || lowerName.startsWith(t))
    const nextProvider: ProviderConfig = {
      id: localProvider?.id ?? name,
      backendKey: name,
      name: localProvider?.name ?? name,
      type: (localProvider?.type ?? matchedType ?? 'custom') as ProviderConfig['type'],
      enabled: true,
      baseUrl: p.base_url || localProvider?.baseUrl || '',
      apiKey: p.api_key || localProvider?.apiKey || '',
      models: mergeProviderModels(localProvider, p.model),
      selectedModelId: '',
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
    if (!p.enabled) continue
    const key = p.backendKey || p.name || p.id
    // Ollama 模型不在 provider.models 里（来自独立缓存），直接用 defaultModel
    const isOllama = p.type === 'ollama' || p.name?.toLowerCase().includes('ollama')
    const selectedModelId = isOllama && p.id === defaultProviderId
      ? defaultModel
      : resolveProviderSelectedModelId(p, p.id === defaultProviderId ? defaultModel : '')
    backendProviders[key] = {
      api_key: p.apiKey || '',
      base_url: p.baseUrl || '',
      model: selectedModelId,
      compatible:
        p.type === 'custom' || !KNOWN_PROVIDER_TYPES.includes(p.type as KnownProviderType)
          ? 'openai'
          : '',
      tools_enabled: p.toolsEnabled ?? null,
      max_tools: p.maxTools ?? 0,
    }
  }
  // Find which provider the default model belongs to
  let defaultProvider = Object.keys(backendProviders)[0] || ''
  const exactDefaultProvider = providers.find(
    (provider) =>
      provider.id === defaultProviderId &&
      provider.enabled &&
      provider.models.some((model) => model.id === defaultModel),
  )
  if (exactDefaultProvider) {
    defaultProvider = exactDefaultProvider.name || exactDefaultProvider.id
  } else {
    for (const [key, val] of Object.entries(backendProviders)) {
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
