import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { connectLogStream, getLogs, getLogStats } from '@/api/logs'
import { trySafe } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { LogEntry, LogStats, ApiError } from '@/types'

const MAX_ENTRIES = 1000

export const useLogsStore = defineStore('logs', () => {
  const entries = ref<LogEntry[]>([])
  const connected = ref(false)
  const filter = ref<{ level?: string; source?: string; keyword?: string }>({})
  const stats = ref<LogStats | null>(null)
  const error = ref<ApiError | null>(null)

  let ws: WebSocket | null = null
  let reconnectDelay = 1000

  /** 过滤后的日志条目 */
  const filteredEntries = computed(() => {
    let result = entries.value

    if (filter.value.level) {
      result = result.filter((e) => e.level === filter.value.level)
    }
    if (filter.value.source) {
      result = result.filter((e) => e.source === filter.value.source)
    }
    if (filter.value.keyword) {
      const kw = filter.value.keyword.toLowerCase()
      result = result.filter((e) => e.message.toLowerCase().includes(kw))
    }

    return result
  })

  /** 建立 WebSocket 连接 */
  function connect() {
    if (ws) return

    ws = connectLogStream(
      (entry) => {
        if (entries.value.length >= MAX_ENTRIES) {
          entries.value.shift()
        }
        entries.value.push(entry)
      },
      () => {
        connected.value = false
        ws = null
        setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      },
    )

    ws.onopen = async () => {
      connected.value = true
      reconnectDelay = 1000
      logger.info('日志流已连接')
      // 加载历史日志
      await loadHistory()
    }

    ws.onclose = () => {
      connected.value = false
      ws = null
    }
  }

  /** 断开连接 */
  function disconnect() {
    if (ws) {
      ws.close()
      ws = null
    }
    connected.value = false
  }

  /** 加载历史日志 */
  async function loadHistory() {
    const [res] = await trySafe(() => getLogs({ limit: MAX_ENTRIES }), '加载历史日志')
    if (res?.logs?.length) {
      // 历史日志是倒序的（最新在前），翻转为正序追加
      const existing = new Set(entries.value.map(e => e.id))
      const newEntries = res.logs.reverse().filter(e => !existing.has(e.id))
      entries.value = [...newEntries, ...entries.value].slice(-MAX_ENTRIES)
    }
  }

  /** 加载统计 */
  async function loadStats() {
    const [res, err] = await trySafe(() => getLogStats(), '加载日志统计')
    if (res) stats.value = res
    error.value = err
  }

  /** 更新过滤器 */
  function setFilter(f: Partial<typeof filter.value>) {
    filter.value = { ...filter.value, ...f }
  }

  /** 清空日志 */
  function clear() {
    entries.value = []
  }

  return {
    entries,
    connected,
    filter,
    stats,
    error,
    filteredEntries,
    connect,
    disconnect,
    loadStats,
    setFilter,
    clear,
  }
})
