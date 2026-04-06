import { apiGet, checkHealth } from './client'
import type { SystemStats } from '@/types'

export type { SystemStats, PlatformInfo } from '@/types'

/** 健康检查 */
export { checkHealth }

/** 获取系统统计 */
export function getStats() {
  return apiGet<SystemStats>('/api/v1/stats')
}

/** 获取版本信息 */
export function getVersion() {
  return apiGet<{ version: string; engine: string; engine_version?: string }>('/api/v1/version')
}
