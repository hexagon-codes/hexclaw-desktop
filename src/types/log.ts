/** 日志条目 */
export interface LogEntry {
  id: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  domain?: string
  fields?: Record<string, unknown>
  trace_id?: string
}

/** 日志查询参数 */
export interface LogQuery {
  /** 显式查询磁盘历史，时间两端为包含关系。 */
  history?: boolean
  level?: string
  source?: string
  domain?: string
  keyword?: string
  start_time?: string // RFC3339Nano
  end_time?: string // RFC3339Nano
  limit?: number
  offset?: number
}

/** 日志统计 */
export interface LogStats {
  total: number
  by_level: Record<string, number>
  by_source: Record<string, number>
  requests_per_minute: number
}
