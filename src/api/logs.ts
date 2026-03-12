import { apiGet, apiWebSocket } from './client'
import { logger } from '@/utils/logger'
import type { LogEntry, LogQuery, LogStats } from '@/types'

export type { LogEntry, LogQuery, LogStats }

/** 查询历史日志 */
export function getLogs(query?: LogQuery) {
  const params = new URLSearchParams()
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined) params.set(k, String(v))
    })
  }
  const qs = params.toString()
  return apiGet<{ logs: LogEntry[]; total: number }>(`/api/v1/logs${qs ? '?' + qs : ''}`)
}

/** 获取日志统计 */
export function getLogStats() {
  return apiGet<LogStats>('/api/v1/logs/stats')
}

/** 建立实时日志 WebSocket 连接 */
export function connectLogStream(
  onMessage: (entry: LogEntry) => void,
  onError?: (err: Event) => void,
): WebSocket {
  const ws = apiWebSocket('/api/v1/logs/stream')

  ws.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data) as LogEntry
      onMessage(entry)
    } catch (e) {
      logger.warn('日志流解析失败', e)
    }
  }

  ws.onerror = (err) => {
    logger.error('日志 WebSocket 连接错误')
    onError?.(err)
  }

  return ws
}
