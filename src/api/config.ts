import { logger } from '@/utils/logger'
import { messageFromUnknownError } from '@/utils/errors'
import type { BackendLLMConfig, LLMConnectionTestRequest, LLMConnectionTestResponse } from '@/types/settings'

function safeJsonParse<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${context}: 后端返回了非 JSON 数据`)
  }
}

async function proxyApiRequestText(method: string, path: string, body: string | null): Promise<string> {
  try {
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
  const text = await proxyApiRequestText('POST', '/api/v1/config/llm/test', JSON.stringify(payload))
  return safeJsonParse<LLMConnectionTestResponse>(text, 'testLLMConnection')
}
