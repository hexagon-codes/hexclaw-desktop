import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { connectLogStream, getLogs, getLogStats } from '@/api/logs'
import { trySafe } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { LogEntry, LogStats, LogQuery, ApiError } from '@/types'
import type { NativeSidecarWebSocket } from '@/api/native-sidecar-websocket'

const MAX_ENTRIES = 1000

export const useLogsStore = defineStore('logs', () => {
  const entries = ref<LogEntry[]>([])
  const connected = ref(false)
  const filter = ref<{ level?: string; source?: string; domain?: string; keyword?: string }>({})
  const stats = ref<LogStats | null>(null)
  const error = ref<ApiError | null>(null)

  let ws: NativeSidecarWebSocket | null = null
  let reconnectDelay = 1000
  // 主动关闭标志 + 重连定时器句柄（bug 2026-06-22 D：防 disconnect 后僵尸重连）
  let closing = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** 过滤后的日志条目 */
  const filteredEntries = computed(() => {
    let result = entries.value

    if (filter.value.level) {
      result = result.filter((e) => e.level === filter.value.level)
    }
    if (filter.value.source) {
      result = result.filter((e) => e.source === filter.value.source)
    }
    if (filter.value.domain) {
      result = result.filter((e) => e.domain === filter.value.domain)
    }
    if (filter.value.keyword) {
      const kw = filter.value.keyword.toLowerCase()
      result = result.filter((e) =>
        e.message.toLowerCase().includes(kw)
        || e.source?.toLowerCase().includes(kw)
        || e.domain?.toLowerCase().includes(kw)
        || e.trace_id?.toLowerCase().includes(kw),
      )
    }

    return result
  })

  let reconnecting = false

  /** 建立 WebSocket 连接 */
  function connect() {
    if (ws) return
    closing = false

    const socket = connectLogStream(
      (entry) => {
        if (entries.value.length >= MAX_ENTRIES) {
          entries.value = [...entries.value.slice(1), entry]
        } else {
          entries.value.push(entry)
        }
      },
      () => {
        connected.value = false
        ws = null
      },
    )
    ws = socket

    socket.onopen = async () => {
      connected.value = true
      reconnectDelay = 1000
      reconnecting = false
      logger.info('日志流已连接')
      await loadHistory()
    }

    socket.onclose = () => {
      connected.value = false
      ws = null
      if (closing) return // 主动关闭，不重连
      if (!reconnecting) {
        reconnecting = true
        reconnectTimer = setTimeout(() => {
          reconnecting = false
          reconnectTimer = null
          connect()
        }, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      }
    }
  }

  /** 断开连接 */
  function disconnect() {
    closing = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnecting = false
    if (ws) {
      ws.onclose = null // 解绑，防止 close() 触发的 onclose 调度重连
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

  // ─── 派生级别计数（集中维护，Vue 缓存：仅 entries 变化时重算）───
  const levelCounts = computed(() => {
    const c: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const e of entries.value) {
      if (c[e.level] !== undefined) c[e.level]!++
    }
    return c
  })

  // ─── 派生子系统（domain）计数。domain 由后端 inferLogDomain(source) 派生为固定 5 桶，
  //     选项列表静态（见 LogsView DOMAINS），这里只统计实时缓冲里各桶的条数供徽标用。───
  const domainCounts = computed(() => {
    const c: Record<string, number> = {}
    for (const e of entries.value) {
      if (e.domain) c[e.domain] = (c[e.domain] || 0) + 1
    }
    return c
  })

  // ─── 历史检索：实时缓冲只保留最近 MAX_ENTRIES 条，查更早 / 全量走服务端 getLogs ───
  const mode = ref<'live' | 'history'>('live')
  const historyEntries = ref<LogEntry[]>([])
  const historyLoading = ref(false)

  /** 展示用条目：history 模式用服务端查询结果（newest-first），live 模式用本地过滤缓冲 */
  const displayedEntries = computed(() =>
    mode.value === 'history' ? historyEntries.value : filteredEntries.value,
  )

  /** 在全部历史中检索（服务端过滤），切到 history 模式 */
  async function searchHistory(query: LogQuery = {}) {
    historyLoading.value = true
    const [res] = await trySafe(() => getLogs({ limit: 500, ...query }), '搜索历史日志')
    historyEntries.value = res?.logs ?? []
    mode.value = 'history'
    historyLoading.value = false
  }

  /** 退出历史检索，回到实时流 */
  function exitHistory() {
    mode.value = 'live'
    historyEntries.value = []
  }

  return {
    entries,
    connected,
    filter,
    stats,
    error,
    filteredEntries,
    levelCounts,
    domainCounts,
    mode,
    historyEntries,
    historyLoading,
    displayedEntries,
    connect,
    disconnect,
    loadHistory,
    loadStats,
    setFilter,
    clear,
    searchHistory,
    exitHistory,
  }
})
