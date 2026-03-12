import { apiGet, apiPut } from './client'
import type { AppConfig } from '@/types'

export type { AppConfig, LLMConfig, SecurityConfig, GeneralConfig } from '@/types'

/** 获取全部配置 */
export function getConfig() {
  return apiGet<AppConfig>('/api/v1/config')
}

/** 更新配置 (部分更新) */
export function updateConfig(config: Partial<AppConfig>) {
  return apiPut<AppConfig>('/api/v1/config', config)
}

/** 获取支持的 LLM 模型列表 */
export function getModels() {
  return apiGet<{ models: { id: string; name: string; provider: string }[] }>('/api/v1/models')
}
