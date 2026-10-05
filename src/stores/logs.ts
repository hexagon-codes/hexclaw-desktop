import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { connectLogStream, getLogs, getLogStats } from '@/api/logs'
import { trySafe } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { LogEntry, LogStats, LogQuery, ApiError } from '@/types'
import type { NativeSidecarWebSocket } from '@/api/native-sidecar-websocket'

const MAX_ENTRIES = 8000
const MEASUREMENT_FIELDS = new Set(['elapsed_ms', 'duration_ms', 'latency_ms', 'retry_delay_ms'])

export interface LogGroup {
  key: string
  records: LogEntry[]
  first: LogEntry
  latest: LogEntry
}

// 对象字段顺序不参与事件身份，数组顺序及字段值仍保持原义。
function canonicalLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalLogValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonicalLogValue(item)]),
    )
  }
  return value
}

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
  const historyTotal = ref(0)
  const historyOffset = ref(0)
  const historyLimit = 500
  const historyQuery = ref<LogQuery | null>(null)
  const historyPage = computed(() => Math.floor(historyOffset.value / historyLimit) + 1)
  const historyPages = computed(() => Math.max(1, Math.ceil(historyTotal.value / historyLimit)))
  const historyHasResults = computed(() => historyQuery.value !== null)
  let historyGeneration = 0

  /** 展示用条目：history 模式用服务端查询结果（newest-first），live 模式用本地过滤缓冲 */
  const displayedEntries = computed(() =>
    mode.value === 'history' ? historyEntries.value : filteredEntries.value,
  )

  // 只投影当前原始结果，不维护跨窗口计数；测量字段保留在每条原始记录中。
  const displayedGroups = computed<LogGroup[]>(() => {
    const groups = new Map<string, LogGroup>()
    const direction = mode.value === 'history' ? -1 : 1
    for (const entry of displayedEntries.value) {
      const fields = Object.fromEntries(
        Object.entries(entry.fields ?? {}).filter(([key]) => !MEASUREMENT_FIELDS.has(key)),
      )
      const key = JSON.stringify(canonicalLogValue({
        message: entry.message,
        source: entry.source,
        domain: entry.domain,
        level: entry.level,
        trace_id: entry.trace_id ?? '',
        fields,
      }))
      const group = groups.get(key)
      if (!group) {
        groups.set(key, { key, records: [entry], first: entry, latest: entry })
        continue
      }
      group.records.push(entry)
      const timestamp = Date.parse(entry.timestamp)
      const firstTime = Date.parse(group.first.timestamp)
      const latestTime = Date.parse(group.latest.timestamp)
      // 同一毫秒内沿原始记录顺序取首末，历史结果与实时流的顺序相反。
      if (timestamp < firstTime || (timestamp === firstTime && direction === -1)) group.first = entry
      if (timestamp > latestTime || (timestamp === latestTime && direction === 1)) group.latest = entry
    }
    return [...groups.values()].sort((a, b) =>
      direction * (Date.parse(a.latest.timestamp) - Date.parse(b.latest.timestamp)),
    )
  })

  /** 只在成功后替换当前页，离开历史后的迟到响应不再提交。 */
  async function loadHistoryPage(query: LogQuery, offset: number) {
    const generation = ++historyGeneration
    mode.value = 'history'
    historyLoading.value = true
    const [res, err] = await trySafe(
      () => getLogs({ ...query, history: true, limit: historyLimit, offset }),
      '搜索历史日志',
    )
    if (generation !== historyGeneration || mode.value !== 'history') return
    error.value = err
    if (res) {
      historyEntries.value = res.logs
      historyTotal.value = res.total
      historyOffset.value = res.total === 0 ? 0 : offset
      historyQuery.value = { ...query }
    }
    historyLoading.value = false
    return err
  }

  /** 新查询捕获最近七天的默认范围，分页只复用已成功提交的条件。 */
  async function searchHistory(query: LogQuery = {}) {
    if (historyLoading.value) return
    let boundedQuery = query
    if (query.start_time === undefined && query.end_time === undefined) {
      const end = new Date()
      boundedQuery = {
        ...query,
        start_time: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: end.toISOString(),
      }
    }
    return loadHistoryPage(boundedQuery, 0)
  }

  /** 翻页使用已提交范围，不读取尚未提交的日期输入。 */
  async function changeHistoryPage(direction: -1 | 1) {
    const offset = historyOffset.value + direction * historyLimit
    if (historyLoading.value || !historyQuery.value || offset < 0 || offset >= historyTotal.value) return
    return loadHistoryPage(historyQuery.value, offset)
  }

  /** 退出历史检索，回到实时流 */
  function exitHistory() {
    historyGeneration++
    historyLoading.value = false
    mode.value = 'live'
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
    historyTotal,
    historyOffset,
    historyLimit,
    historyPage,
    historyPages,
    historyHasResults,
    displayedEntries,
    displayedGroups,
    connect,
    disconnect,
    loadHistory,
    loadStats,
    setFilter,
    clear,
    searchHistory,
    changeHistoryPage,
    exitHistory,
  }
})
