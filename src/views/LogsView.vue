<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ScrollText, Trash2, Download, ChevronDown, ChevronRight, Package, RefreshCw } from 'lucide-vue-next'
import { useLogsStore } from '@/stores/logs'
import PageHeader from '@/components/common/PageHeader.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SearchInput from '@/components/common/SearchInput.vue'

const { t } = useI18n()

const logsStore = useLogsStore()
const autoScroll = ref(true)
const logsContainer = ref<HTMLDivElement>()
const expandedIds = ref<Set<string>>(new Set())
const now = ref(Date.now())
const refreshing = ref(false)

// Level counts from in-memory entries
const levelCounts = computed(() => {
  const counts: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const e of logsStore.entries) {
    if (counts[e.level] !== undefined) counts[e.level]!++
  }
  return counts
})

const domainCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const entry of logsStore.entries) {
    if (!entry.domain) continue
    counts[entry.domain] = (counts[entry.domain] || 0) + 1
  }
  return counts
})

const availableDomains = computed(() => Object.keys(domainCounts.value).sort())

const recentFailures = computed(() =>
  logsStore.filteredEntries
    .filter((entry) => entry.level === 'warn' || entry.level === 'error')
    .slice(-5)
    .reverse(),
)

const errorCount = computed(() =>
  logsStore.filteredEntries.filter((entry) => entry.level === 'error').length,
)

const warnCount = computed(() =>
  logsStore.filteredEntries.filter((entry) => entry.level === 'warn').length,
)

const levelTabs = computed(() => [
  { key: '', label: `${t('logs.all')} (${logsStore.entries.length})` },
  { key: 'debug', label: `Debug (${levelCounts.value.debug})` },
  { key: 'info', label: `Info (${levelCounts.value.info})` },
  { key: 'warn', label: `Warn (${levelCounts.value.warn})` },
  { key: 'error', label: `Error (${levelCounts.value.error})` },
])

const activeLevel = ref(logsStore.filter.level || '')

let nowTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  logsStore.connect()
  logsStore.loadStats()
  // Update "now" every second for relative timestamps
  nowTimer = setInterval(() => { now.value = Date.now() }, 1000)
})

// Auto-scroll when new log entries arrive
watch(() => logsStore.entries.length, () => {
  scrollToBottom()
})

watch(activeLevel, (level) => {
  logsStore.setFilter({ level: level || undefined })
})

onUnmounted(() => {
  logsStore.disconnect()
  if (nowTimer) clearInterval(nowTimer)
})

function setDomain(domain: string) {
  logsStore.setFilter({ domain: domain || undefined })
}

function clearLogs() {
  logsStore.clear()
  expandedIds.value.clear()
}

function toggleExpand(id: string) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  expandedIds.value = next
}

function exportLogs() {
  const entries = logsStore.filteredEntries
  if (entries.length === 0) return

  const lines = entries.map(e => {
    const ts = formatTime(e.timestamp)
    return `[${ts}] [${e.level.toUpperCase().padEnd(5)}] [${e.source || '-'}] ${e.message}`
  })

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  a.download = `hexclaw-logs-${dateStr}.log`
  a.click()
  URL.revokeObjectURL(url)
}

function refreshLogs() {
  void runRefreshLogs()
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function waitForReconnect(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (logsStore.connected) {
      resolve()
      return
    }

    const stop = watch(
      () => logsStore.connected,
      (connected) => {
        if (connected) {
          cleanup()
          resolve()
        }
      },
    )

    const timer = window.setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    function cleanup() {
      stop()
      window.clearTimeout(timer)
    }
  })
}

async function runRefreshLogs() {
  if (refreshing.value) return

  refreshing.value = true
  try {
    const statsPromise = logsStore.loadStats()
    logsStore.disconnect()
    logsStore.connect()
    await Promise.allSettled([
      statsPromise,
      wait(700),
      waitForReconnect(),
    ])
  } finally {
    refreshing.value = false
  }
}

function exportDiagnostics() {
  const payload = {
    exported_at: new Date().toISOString(),
    filter: logsStore.filter,
    stats: logsStore.stats,
    entries: logsStore.filteredEntries,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hexclaw-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// 自动滚动到底部
function scrollToBottom() {
  if (autoScroll.value && logsContainer.value) {
    nextTick(() => {
      logsContainer.value!.scrollTop = logsContainer.value!.scrollHeight
    })
  }
}

function handleScroll() {
  if (!logsContainer.value) return
  const { scrollTop, scrollHeight, clientHeight } = logsContainer.value
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 50
}

const levelColor: Record<string, string> = {
  debug: '#8b8b8b',
  info: '#3b82f6',
  warn: '#eab308',
  error: '#ef4444',
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch {
    return ts
  }
}

function formatRelativeTime(ts: string): string {
  try {
    const diff = now.value - new Date(ts).getTime()
    if (diff < 0) return '刚刚'
    const seconds = Math.floor(diff / 1000)
    if (seconds < 5) return '刚刚'
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  } catch {
    return ts
  }
}
</script>

<template>
  <div class="hc-logs-page h-full flex flex-col overflow-hidden">
    <PageToolbar>
      <template #tabs>
        <SegmentedControl
          v-model="activeLevel"
          :segments="levelTabs.map(l => ({ key: l.key, label: l.label }))"
        />
      </template>
      <template #center>
        <div class="hc-logs__toolbar-filters">
          <select
            v-if="availableDomains.length > 0"
            class="hc-input hc-logs__domain"
            :value="logsStore.filter.domain || ''"
            @change="setDomain(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('logs.allDomains') }}</option>
            <option v-for="domain in availableDomains" :key="domain" :value="domain">
              {{ domain }} ({{ domainCounts[domain] }})
            </option>
          </select>
          <div class="hc-logs__search">
            <SearchInput
              :model-value="logsStore.filter.keyword || ''"
              :placeholder="t('logs.searchPlaceholder')"
              @update:model-value="logsStore.setFilter({ keyword: $event || undefined })"
            />
          </div>
          <label class="hc-logs__autoscroll">
            <input v-model="autoScroll" type="checkbox" class="accent-blue-500 w-3 h-3" />
            <span>Auto-scroll</span>
          </label>
        </div>
      </template>
      <template #actions>
        <button class="hc-btn hc-btn-ghost" @click="exportLogs">
          <Download :size="14" />
          {{ t('logs.exportLogs', '导出日志') }}
        </button>
        <button class="hc-btn hc-btn-ghost" @click="exportDiagnostics">
          <Package :size="14" />
          {{ t('logs.exportDiagnostics', 'Download Diagnostics') }}
        </button>
        <button class="hc-btn hc-btn-primary" :disabled="refreshing" @click="refreshLogs">
          <RefreshCw :size="14" :class="{ 'hc-spin-icon': refreshing }" />
          {{ t('logs.refreshLogs', 'Refresh Logs') }}
        </button>
        <button
          class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-text-secondary)' }"
          :title="t('common.delete')"
          @click="clearLogs"
        >
          <Trash2 :size="16" />
        </button>
      </template>
    </PageToolbar>

    <PageHeader
      :eyebrow="t('logs.eyebrow', '诊断')"
      :title="t('logs.title')"
      :description="t('logs.description')"
      :status="logsStore.connected ? t('logs.connected', '已连接') : t('logs.disconnected', '未连接')"
      :status-variant="logsStore.connected ? 'success' : 'error'"
    />

    <!-- 日志流 -->
    <div ref="logsContainer" class="flex-1 overflow-y-auto font-mono text-xs" @scroll="handleScroll">
      <div
        v-for="entry in logsStore.filteredEntries"
        :key="entry.id"
        class="border-b border-white/[0.03]"
      >
        <div
          class="hc-logs__row flex items-start gap-3 px-6 py-1.5 cursor-pointer"
          @click="toggleExpand(entry.id)"
        >
          <component
            :is="expandedIds.has(entry.id) ? ChevronDown : ChevronRight"
            :size="12"
            class="shrink-0 mt-0.5"
            :style="{ color: 'var(--hc-text-muted)' }"
          />
          <span class="text-[10px] tabular-nums shrink-0 pt-0.5" :style="{ color: 'var(--hc-text-muted)' }" :title="formatTime(entry.timestamp)">
            {{ formatRelativeTime(entry.timestamp) }}
          </span>
          <span
            class="w-12 text-center rounded text-[10px] font-bold uppercase shrink-0 pt-0.5"
            :style="{ color: levelColor[entry.level] || 'var(--hc-text-secondary)' }"
          >
            {{ entry.level }}
          </span>
          <span class="text-[10px] shrink-0 pt-0.5 w-16 truncate" :style="{ color: 'var(--hc-text-muted)' }">
            {{ entry.source }}
          </span>
          <span class="flex-1 break-all" :class="{ 'truncate': !expandedIds.has(entry.id) }" :style="{ color: 'var(--hc-text-primary)' }">
            {{ entry.message }}
          </span>
        </div>

        <!-- 展开详情 -->
        <div
          v-if="expandedIds.has(entry.id)"
          class="px-6 py-2 ml-[21px] space-y-1"
          :style="{ background: 'var(--hc-bg-hover)' }"
        >
          <div class="flex gap-8 text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
            <span>ID: {{ entry.id }}</span>
            <span>Source: {{ entry.source || '-' }}</span>
            <span>Domain: {{ entry.domain || '-' }}</span>
            <span>Level: {{ entry.level }}</span>
            <span>Time: {{ entry.timestamp }}</span>
          </div>
          <pre class="text-[11px] whitespace-pre-wrap break-all mt-1" :style="{ color: 'var(--hc-text-primary)' }">{{ entry.message }}</pre>
        </div>
      </div>

      <div v-if="logsStore.filteredEntries.length === 0" class="flex items-center justify-center h-full">
        <div class="text-center" :style="{ color: 'var(--hc-text-muted)' }">
          <ScrollText :size="40" class="mx-auto mb-3 opacity-30" />
          <p class="text-sm">{{ logsStore.connected ? t('logs.connected') : t('logs.disconnected') }}</p>
        </div>
      </div>
    </div>

    <!-- 底部状态栏 -->
    <div
      class="flex items-center gap-6 px-6 py-1.5 border-t text-[11px]"
      :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-muted)', background: 'var(--hc-bg-sidebar)' }"
    >
      <span class="flex items-center gap-1.5">
        <span
          class="w-1.5 h-1.5 rounded-full"
          :style="{ background: logsStore.connected ? 'var(--hc-success, #34C759)' : 'var(--hc-error, #FF3B30)' }"
        />
        {{ logsStore.connected ? t('logs.connected', '已连接') : t('logs.disconnected', '未连接') }}
      </span>
      <span>Total: {{ logsStore.filteredEntries.length }}</span>
      <span :style="{ color: levelColor.info }">Info: {{ levelCounts.info }}</span>
      <span :style="{ color: levelColor.warn }">Warn: {{ levelCounts.warn }}</span>
      <span :style="{ color: levelColor.error }">Error: {{ levelCounts.error }}</span>
      <span v-if="logsStore.stats">{{ logsStore.stats.requests_per_minute?.toFixed(1) || 0 }} req/min</span>
    </div>
  </div>
</template>

<style scoped>
.hc-logs__row {
  transition: background 0.12s;
}

.hc-logs__row:hover {
  background: var(--hc-bg-hover);
}

.hc-logs__toolbar-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-logs__domain {
  width: auto;
  min-width: 120px;
  height: 28px;
  padding: 0 28px 0 10px;
  line-height: 26px;
  box-sizing: border-box;
  font-size: 12px;
}

.hc-logs__search :deep(.hc-search) {
  width: 200px;
  height: 28px;
}

.hc-logs__autoscroll {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
}

.hc-spin-icon {
  animation: hc-log-spin 1s linear infinite;
}

@keyframes hc-log-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1100px) {
  .hc-logs__toolbar-filters {
    flex-wrap: wrap;
  }

  .hc-logs__search :deep(.hc-search) {
    width: 160px;
  }
}
</style>
