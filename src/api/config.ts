import { logger } from '@/utils/logger'
import { messageFromUnknownError } from '@/utils/errors'
import { env } from '@/config/env'
import { isTauri } from '@/utils/platform'
import type { BackendLLMConfig, CatalogModel, LLMConnectionTestRequest, LLMConnectionTestResponse } from '@/types/settings'

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

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true
  }

  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    const a = octets[0] ?? -1
    const b = octets[1] ?? -1
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }

  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
}

function assertExternalBaseUrlAllowed(baseUrl: string, providerType?: string): void {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Invalid URL format')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid URL protocol')
  }

  if (providerType?.toLowerCase() === 'ollama') {
    // Ollama runs locally — only allow loopback addresses
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1') {
      return
    }
    throw new Error('Ollama is only allowed on localhost')
  }

  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('Unsafe base_url: internal or private network hosts are not allowed')
  }
}

/**
 * 从后端获取 LLM 配置（API Key 已脱敏）
 */
export async function getLLMConfig(): Promise<BackendLLMConfig> {
  const text = await proxyApiRequestText('GET', '/api/v1/config/llm', null)
  return safeJsonParse<BackendLLMConfig>(text, 'getLLMConfig')
}

/**
 * 更新后端 LLM 配置（持久化到 ~/.hexclaw/hexclaw.yaml）
 */
export async function updateLLMConfig(config: BackendLLMConfig): Promise<void> {
  const text = await proxyApiRequestText('PUT', '/api/v1/config/llm', JSON.stringify(config))
  const result = safeJsonParse(text, 'updateLLMConfig')
  logger.debug('LLM config updated:', result)
}

/**
 * 测试单个 Provider 连接（不持久化）
 */
export async function testLLMConnection(
  payload: LLMConnectionTestRequest,
): Promise<LLMConnectionTestResponse> {
  assertExternalBaseUrlAllowed(payload.provider.base_url, payload.provider.type)
  const text = await proxyApiRequestText('POST', '/api/v1/config/llm/test', JSON.stringify(payload))
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
): Promise<CatalogModel[]> {
  try {
    assertExternalBaseUrlAllowed(baseUrl)
  } catch (e) {
    logger.warn('fetchProviderModels: URL blocked by SSRF check:', messageFromUnknownError(e))
    return []
  }
  const text = await proxyApiRequestText(
    'POST',
    '/api/v1/config/llm/models',
    JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
  )
  const result = safeJsonParse<{ models?: BackendProviderModel[] }>(text, 'fetchProviderModels')
  return (result.models ?? []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length,
    promptPrice: m.prompt_price,
    completionPrice: m.completion_price,
    inputModalities: m.input_modalities,
    supportsTools: m.supports_tools,
  }))
}
