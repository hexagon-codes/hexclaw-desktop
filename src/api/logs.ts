import { apiGet, apiWebSocket } from './client'
import { logger } from '@/utils/logger'
import type { LogEntry, LogQuery, LogStats } from '@/types'

export type { LogEntry, LogQuery, LogStats }

/** 查询历史日志 */
export function getLogs(query?: LogQuery) {
  const q: Record<string, unknown> = {}
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) q[k] = v
    }
  }
  return apiGet<{ logs: LogEntry[]; total: number }>('/api/v1/logs', Object.keys(q).length > 0 ? q : undefined)
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
      logger.warn('Failed to parse log stream payload', e)
    }
  }

  ws.onerror = (err) => {
    logger.error('Log WebSocket connection error')
    onError?.(err)
  }

  return ws
}
