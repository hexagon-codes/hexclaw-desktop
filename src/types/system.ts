/** 系统统计 */
export interface SystemStats {
  uptime: number
  total_requests: number
  total_tokens: number
  total_cost: number
  active_sessions: number
  active_agents: number
  memory_usage: number
}

/** 平台信息 */
export interface PlatformInfo {
  os: string
  arch: string
  version: string
}
