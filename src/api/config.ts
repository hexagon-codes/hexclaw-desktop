import { logger } from '@/utils/logger'
import { messageFromUnknownError } from '@/utils/errors'
import { env } from '@/config/env'
import { isTauri } from '@/utils/platform'
import {
  classifyProviderEndpoint,
  matchesProviderPrivateNetworkAccess,
} from '@/utils/provider-endpoint'
import type {
  BackendLLMConfig,
  CatalogModel,
  LLMConnectionTestRequest,
  LLMConnectionTestResponse,
  ModelReasoningControl,
  PrivateNetworkAccess,
  ProviderLocality,
  ProviderCredentialReplacement,
  ProviderType,
} from '@/types/settings'
import type { ModelReasoningSupport } from '@/types/settings'
import { normalizeModelReasoningSupport } from '@/config/model-contract'

function safeJsonParse<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${context}: backend returned a non-JSON payload`)
  }
}

async function proxyApiRequestText(method: string, path: string, body: string | null): Promise<string> {
  try {
    if (!isTauri()) {
      const response = await fetch(`${env.apiBase}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: body ?? undefined,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(text || `${response.status} ${response.statusText}`)
      }
      return text
    }

    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('proxy_api_request', {
      method,
      path,
      body,
    })
  } catch (e) {
    throw new Error(messageFromUnknownError(e))
  }
}

/** 一次性明文回读（方案A，2026-08-17 批准）：仅本机 Tauri 环境可用，浏览器环境直接失败。 */
export async function readProviderApiKey(providerId: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('reading saved API keys is only available in the desktop app')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const value = await invoke<string | null>('read_provider_api_key', { providerId })
  return value ?? ''
}

interface ProviderEndpointContext {
  providerType?: ProviderType
  /** 已持久化 Provider 的稳定后端身份；目录同步据此使用后端保存的真实凭据。 */
  providerInstanceId?: string
  locality?: ProviderLocality
  privateNetworkAccess?: PrivateNetworkAccess
}

function assertExternalBaseUrlAllowed(
  baseUrl: string,
  { providerType, privateNetworkAccess }: ProviderEndpointContext = {},
): void {
  // 空 base_url：后端 validateExternalProviderBaseURL 直接放行（走 SDK 默认 endpoint），
  // 前端不应强拦——否则只填 api_key+model 的云 provider 连「测试连接」都发不出去。
  if (baseUrl.trim() === '') return
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Invalid URL format')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid URL protocol')
  }

  const decision = classifyProviderEndpoint(providerType ?? 'custom', baseUrl)
  if (decision.classification === 'blocked') {
    if (providerType?.toLowerCase() === 'ollama' && !decision.requiresPrivateNetworkAccess) {
      throw new Error('Ollama is only allowed on localhost')
    }
    throw new Error('Unsafe base_url: internal or private network hosts are not allowed')
  }

  // 同机 loopback 可直接使用；RFC1918/ULA 只接受当前主机的显式授权，防止授权被换址复用。
  if (
    decision.requiresPrivateNetworkAccess &&
    !matchesProviderPrivateNetworkAccess(baseUrl, privateNetworkAccess)
  ) {
    throw new Error('Unsafe base_url: internal or private network hosts are not allowed')
  }
}

/**
 * 从后端获取 LLM 配置（Tauri 命令会从 owner YAML 回灌明文 API key）
 */
export async function getLLMConfig(): Promise<BackendLLMConfig> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<BackendLLMConfig>('get_llm_config_with_credentials')
  }
  const text = await proxyApiRequestText('GET', '/api/v1/config/llm', null)
  return safeJsonParse<BackendLLMConfig>(text, 'getLLMConfig')
}

/**
 * 更新后端 LLM 配置（持久化到 ~/.hexclaw/hexclaw.yaml）
 */
export async function updateLLMConfig(
  config: BackendLLMConfig,
  replacements: ProviderCredentialReplacement[] = [],
): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('apply_llm_config_with_credentials', { config, replacements })
    logger.debug('LLM config updated by native credential coordinator')
    return
  }
  const text = await proxyApiRequestText('PUT', '/api/v1/config/llm', JSON.stringify(config))
  const result = safeJsonParse(text, 'updateLLMConfig')
  logger.debug('LLM config updated:', result)
}

/**
 * 测试单个 Provider 连接；提供稳定实例 ID 时由后端持久化测试回执。
 */
export async function testLLMConnection(
  payload: LLMConnectionTestRequest,
  context: Pick<
    ProviderEndpointContext,
    'providerInstanceId' | 'locality' | 'privateNetworkAccess'
  > = {},
): Promise<LLMConnectionTestResponse> {
  assertExternalBaseUrlAllowed(payload.provider.base_url, {
    providerType: payload.provider.type,
    locality: context.locality,
    privateNetworkAccess: context.privateNetworkAccess,
  })
  const text = await proxyApiRequestText(
    'POST',
    '/api/v1/config/llm/test',
    JSON.stringify({
      provider: {
        ...payload.provider,
        provider_instance_id: context.providerInstanceId,
        locality: context.locality,
        private_network_access: context.privateNetworkAccess,
      },
    }),
  )
  return safeJsonParse<LLMConnectionTestResponse>(text, 'testLLMConnection')
}

/** 后端 /api/v1/config/llm/models 返回的模型条目（snake_case） */
interface BackendProviderModel {
  id: string
  name?: string
  context_length?: number
  prompt_price?: string
  completion_price?: string
  input_modalities?: string[]
  supports_tools?: boolean
  reasoning_support?: ModelReasoningSupport
  reasoning_control?: ModelReasoningControl
}

/**
 * 从 Provider 的 /models 端点动态获取可用模型目录
 *
 * 大多数 Provider 兼容 OpenAI 格式：GET {base_url}/models → { data: [{ id, ... }] }
 * OpenRouter 等聚合商额外返回 pricing / modalities / tools 元数据，由后端透传。
 * Ollama 由 syncOllamaModels 单独处理，此函数用于云端 Provider。
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  context: ProviderEndpointContext = {},
): Promise<CatalogModel[]> {
  assertExternalBaseUrlAllowed(baseUrl, context)
  const text = await proxyApiRequestText(
    'POST',
    '/api/v1/config/llm/models',
    JSON.stringify({
      provider_instance_id: context.providerInstanceId,
      base_url: baseUrl,
      api_key: apiKey,
      locality: context.locality,
      private_network_access: context.privateNetworkAccess,
    }),
  )
  const result = safeJsonParse<{ models?: BackendProviderModel[]; error?: string }>(
    text,
    'fetchProviderModels',
  )
  if (result.error?.trim()) {
    throw new Error(`fetchProviderModels: ${result.error.trim()}`)
  }
  const models = (result.models ?? []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length,
    promptPrice: m.prompt_price,
    completionPrice: m.completion_price,
    inputModalities: m.input_modalities,
    supportsTools: m.supports_tools,
    reasoningSupport: normalizeModelReasoningSupport(m.reasoning_support),
    reasoningControl: m.reasoning_control,
  }))
  if (models.length === 0) {
    throw new Error('fetchProviderModels: empty model catalog')
  }
  return models
}
