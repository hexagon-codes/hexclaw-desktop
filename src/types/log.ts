/** 日志条目 */
export interface LogEntry {
  id: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  fields?: Record<string, unknown>
  trace_id?: string
}

/** 日志查询参数 */
export interface LogQuery {
  level?: string
  source?: string
  keyword?: string
  start_time?: string
  end_time?: string
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
