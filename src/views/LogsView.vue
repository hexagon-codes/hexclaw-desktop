<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ScrollText, Trash2, Download, ChevronDown, ChevronRight, Package, RefreshCw } from 'lucide-vue-next'
import { useLogsStore } from '@/stores/logs'
import PageHeader from '@/components/common/PageHeader.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'

const { t } = useI18n()

const logsStore = useLogsStore()
const autoScroll = ref(true)
const logsContainer = ref<HTMLDivElement>()
const expandedIds = ref<Set<string>>(new Set())
const now = ref(Date.now())

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

const activeLevel = ref('')

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

onUnmounted(() => {
  logsStore.disconnect()
  if (nowTimer) clearInterval(nowTimer)
})

function setLevel(level: string) {
  activeLevel.value = level
  logsStore.setFilter({ level: level || undefined })
}

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
  logsStore.loadStats()
  logsStore.disconnect()
  logsStore.connect()
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
  <div class="h-full flex flex-col overflow-hidden">
    <PageToolbar :search-placeholder="t('logs.searchPlaceholder', 'Search logs, error codes...')">
      <template #tabs>
        <SegmentedControl
          v-model="activeLevel"
          :segments="levelTabs.map(l => ({ key: l.key, label: l.label }))"
        />
      </template>
      <template #actions>
        <StatusBadge :status="logsStore.connected ? 'online' : 'offline'" />
        <button
          class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-text-secondary)' }"
          :title="t('common.download')"
          @click="exportLogs"
        >
          <Download :size="16" />
        </button>
        <button class="hc-btn hc-btn-ghost" @click="exportDiagnostics">
          <Package :size="14" />
          {{ t('logs.exportDiagnostics', 'Download Diagnostics') }}
        </button>
        <button class="hc-btn hc-btn-primary" @click="refreshLogs">
          <RefreshCw :size="14" />
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
      :eyebrow="t('logs.eyebrow', 'diagnostics')"
      :title="t('logs.title')"
      :description="t('logs.description')"
      :status="logsStore.connected ? t('logs.connected', 'Connected') : t('logs.disconnected', 'Disconnected')"
      :status-variant="logsStore.connected ? 'success' : 'error'"
    />

    <!-- Filters -->
    <div class="flex items-center gap-3 px-6 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <div class="flex gap-1">
        <button
          v-for="tab in levelTabs"
          :key="tab.key"
          class="px-3 py-1 rounded-md text-xs font-medium transition-colors"
          :style="{
            background: activeLevel === tab.key ? 'var(--hc-accent)' : 'transparent',
            color: activeLevel === tab.key ? '#fff' : 'var(--hc-text-secondary)',
          }"
          @click="setLevel(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>
      <div class="flex-1" />
      <select
        v-if="availableDomains.length > 0"
        class="hc-input"
        style="width: auto; min-width: 120px;"
        :value="logsStore.filter.domain || ''"
        @change="setDomain(($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('logs.allDomains') }}</option>
        <option v-for="domain in availableDomains" :key="domain" :value="domain">
          {{ domain }} ({{ domainCounts[domain] }})
        </option>
      </select>
      <SearchInput
        :model-value="logsStore.filter.keyword || ''"
        :placeholder="t('logs.searchPlaceholder')"
        @update:model-value="logsStore.setFilter({ keyword: $event || undefined })"
      />
      <label class="flex items-center gap-1.5 cursor-pointer select-none">
        <input v-model="autoScroll" type="checkbox" class="accent-blue-500 w-3 h-3" />
        <span class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">Auto-scroll</span>
      </label>
      <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
        {{ logsStore.filteredEntries.length }}
      </span>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-3 px-6 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <div class="rounded-xl border px-4 py-3" :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }">
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('logs.summaryVisible') }}</div>
        <div class="text-lg font-semibold mt-1" :style="{ color: 'var(--hc-text-primary)' }">{{ logsStore.filteredEntries.length }}</div>
      </div>
      <div class="rounded-xl border px-4 py-3" :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }">
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('logs.summaryErrors') }}</div>
        <div class="text-lg font-semibold mt-1" style="color: #dc2626;">{{ errorCount }}</div>
      </div>
      <div class="rounded-xl border px-4 py-3" :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }">
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('logs.summaryWarnings') }}</div>
        <div class="text-lg font-semibold mt-1" style="color: #b45309;">{{ warnCount }}</div>
      </div>
      <div class="rounded-xl border px-4 py-3" :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }">
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('logs.summaryDomains') }}</div>
        <div class="text-lg font-semibold mt-1" :style="{ color: 'var(--hc-text-primary)' }">{{ availableDomains.length }}</div>
      </div>
    </div>

    <div v-if="recentFailures.length > 0" class="px-6 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <div class="text-sm font-medium mb-3" :style="{ color: 'var(--hc-text-primary)' }">{{ t('logs.recentFailures') }}</div>
      <div class="space-y-2">
        <div
          v-for="entry in recentFailures"
          :key="`failure-${entry.id}`"
          class="rounded-xl border px-4 py-3"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-center gap-2 text-xs mb-1" :style="{ color: 'var(--hc-text-muted)' }">
            <span :style="{ color: levelColor[entry.level] || 'var(--hc-text-secondary)' }">{{ entry.level.toUpperCase() }}</span>
            <span>{{ entry.domain || entry.source || '-' }}</span>
            <span>{{ formatRelativeTime(entry.timestamp) }}</span>
          </div>
          <div class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ entry.message }}</div>
        </div>
      </div>
    </div>

    <!-- 日志流 -->
    <div ref="logsContainer" class="flex-1 overflow-y-auto font-mono text-xs" @scroll="handleScroll">
      <div
        v-for="entry in logsStore.filteredEntries"
        :key="entry.id"
        class="border-b border-white/[0.03]"
      >
        <div
          class="flex items-start gap-3 px-6 py-1 hover:bg-white/[0.02] cursor-pointer"
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

    <!-- 统计栏 -->
    <div
      v-if="logsStore.stats"
      class="flex items-center gap-6 px-6 py-2 border-t text-xs"
      :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-muted)', background: 'var(--hc-bg-sidebar)' }"
    >
      <span>Total: {{ logsStore.stats.total }}</span>
      <span :style="{ color: levelColor.info }">Info: {{ logsStore.stats.by_level?.info || 0 }}</span>
      <span :style="{ color: levelColor.warn }">Warn: {{ logsStore.stats.by_level?.warn || 0 }}</span>
      <span :style="{ color: levelColor.error }">Error: {{ logsStore.stats.by_level?.error || 0 }}</span>
      <span>{{ logsStore.stats.requests_per_minute?.toFixed(1) || 0 }} req/min</span>
    </div>
  </div>
</template>
