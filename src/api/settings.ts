import { apiPut } from './client'
import type { AppConfig } from '@/types'

export type { AppConfig, LLMConfig, SecurityConfig, GeneralConfig } from '@/types'

/** 更新配置 (部分更新) — 用于安全配置等非 LLM 配置的后端同步 */
export function updateConfig(config: Partial<AppConfig>) {
  return apiPut<AppConfig>('/api/v1/config', config)
}
