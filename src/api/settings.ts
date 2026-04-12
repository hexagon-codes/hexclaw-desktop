import { apiGet, apiPut } from './client'
import type { BackendRuntimeConfig, RuntimeConfigUpdateRequest, ConfigUpdateResponse } from '@/types'

export type {
  AppConfig,
  LLMConfig,
  SecurityConfig,
  GeneralConfig,
  RuntimeConfigUpdateRequest,
  ConfigUpdateResponse,
} from '@/types'

/** 更新配置 (部分更新) — 用于安全/沙箱配置的后端同步 */
export function updateConfig(config: RuntimeConfigUpdateRequest) {
  return apiPut<ConfigUpdateResponse>('/api/v1/config', config)
}

/** 获取后端当前运行时配置快照 */
export function getRuntimeConfig() {
  return apiGet<BackendRuntimeConfig>('/api/v1/config')
}
