/** 系统统计（匹配后端 GET /api/v1/stats） */
export interface SystemStats {
  uptime_seconds: number
  goroutines: number
  memory_alloc_mb: number
  memory_sys_mb: number
  gc_cycles: number
  log_entries: number
}

/** 平台信息 */
export interface PlatformInfo {
  os: string
  arch: string
  version: string
}
