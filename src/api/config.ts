import { logger } from '@/utils/logger'
import type { BackendLLMConfig } from '@/types/settings'

/**
 * 从后端获取 LLM 配置（API Key 已脱敏）
 */
export async function getLLMConfig(): Promise<BackendLLMConfig> {
  const { invoke } = await import('@tauri-apps/api/core')
  const text = await invoke<string>('proxy_api_request', {
    method: 'GET',
    path: '/api/v1/config/llm',
    body: null,
  })
  return JSON.parse(text)
}

/**
 * 更新后端 LLM 配置（持久化到 ~/.hexclaw/hexclaw.yaml）
 */
export async function updateLLMConfig(config: BackendLLMConfig): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const text = await invoke<string>('proxy_api_request', {
    method: 'PUT',
    path: '/api/v1/config/llm',
    body: JSON.stringify(config),
  })
  const result = JSON.parse(text)
  logger.debug('LLM config updated:', result)
}
