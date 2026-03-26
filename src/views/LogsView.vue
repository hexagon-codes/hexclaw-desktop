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
  nowTimer = setInterval(() => { now.value = Date.now() }, 1000)
})

watch(() => logsStore.entries.length, () => { scrollToBottom() })

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
  if (next.has(id)) { next.delete(id) } else { next.add(id) }
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
  a.download = `hexclaw-logs-${new Date().toISOString().slice(0, 10)}.log`
  a.click()
  URL.revokeObjectURL(url)
}

function refreshLogs() { void runRefreshLogs() }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function waitForReconnect(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (logsStore.connected) { resolve(); return }
    const stop = watch(() => logsStore.connected, (connected) => {
      if (connected) { cleanup(); resolve() }
    })
    const timer = window.setTimeout(() => { cleanup(); resolve() }, timeoutMs)
    function cleanup() { stop(); window.clearTimeout(timer) }
  })
}

async function runRefreshLogs() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const statsPromise = logsStore.loadStats()
    logsStore.disconnect()
    logsStore.connect()
    await Promise.allSettled([statsPromise, wait(700), waitForReconnect()])
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

function scrollToBottom() {
  if (autoScroll.value && logsContainer.value) {
    nextTick(() => { logsContainer.value!.scrollTop = logsContainer.value!.scrollHeight })
  }
}

function handleScroll() {
  if (!logsContainer.value) return
  const { scrollTop, scrollHeight, clientHeight } = logsContainer.value
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 50
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch { return ts }
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
  } catch { return ts }
}
</script>

<template>
  <div class="hc-logs-page">
    <!-- 1. Toolbar: level tabs + action buttons -->
    <PageToolbar>
      <template #tabs>
        <SegmentedControl
          v-model="activeLevel"
          :segments="levelTabs.map(l => ({ key: l.key, label: l.label }))"
        />
      </template>
      <template #actions>
        <button class="hc-logs__action-btn" :title="t('logs.exportLogs', '导出日志')" @click="exportLogs">
          <Download :size="14" />
        </button>
        <button class="hc-logs__action-btn" :title="t('logs.exportDiagnostics', '诊断包')" @click="exportDiagnostics">
          <Package :size="14" />
        </button>
        <button
          class="hc-logs__action-btn"
          :class="{ 'hc-logs__action-btn--spinning': refreshing }"
          :title="t('logs.refreshLogs', '刷新')"
          :disabled="refreshing"
          @click="refreshLogs"
        >
          <RefreshCw :size="14" />
        </button>
        <button class="hc-logs__action-btn" :title="t('common.delete')" @click="clearLogs">
          <Trash2 :size="14" />
        </button>
      </template>
    </PageToolbar>

    <!-- 2. PageHeader: title + status + filter controls in actions slot -->
    <PageHeader
      :eyebrow="t('logs.eyebrow', '诊断')"
      :title="t('logs.title')"
      :description="t('logs.description')"
      :status="logsStore.connected ? t('logs.connected', '已连接') : t('logs.disconnected', '未连接')"
      :status-variant="logsStore.connected ? 'success' : 'error'"
    >
      <template #actions>
        <div class="hc-logs__header-filters">
          <select
            v-if="availableDomains.length > 0"
            class="hc-logs__domain"
            :value="logsStore.filter.domain || ''"
            @change="setDomain(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('logs.allDomains') }}</option>
            <option v-for="domain in availableDomains" :key="domain" :value="domain">
              {{ domain }} ({{ domainCounts[domain] }})
            </option>
          </select>
          <SearchInput
            class="hc-logs__search"
            :model-value="logsStore.filter.keyword || ''"
            :placeholder="t('logs.searchPlaceholder')"
            @update:model-value="logsStore.setFilter({ keyword: $event || undefined })"
          />
          <label class="hc-logs__autoscroll">
            <input v-model="autoScroll" type="checkbox" />
            <span>Auto-scroll</span>
          </label>
        </div>
      </template>
    </PageHeader>

    <!-- 3. Log stream (maximum content area) -->
    <div ref="logsContainer" class="hc-logs__stream" @scroll="handleScroll">
      <div
        v-for="entry in logsStore.filteredEntries"
        :key="entry.id"
        class="hc-logs__entry"
      >
        <div class="hc-logs__row" @click="toggleExpand(entry.id)">
          <component
            :is="expandedIds.has(entry.id) ? ChevronDown : ChevronRight"
            :size="12"
            class="hc-logs__row-icon"
          />
          <span class="hc-logs__row-time" :title="formatTime(entry.timestamp)">
            {{ formatRelativeTime(entry.timestamp) }}
          </span>
          <span class="hc-logs__row-level" :class="`hc-logs__row-level--${entry.level}`">
            {{ entry.level }}
          </span>
          <span class="hc-logs__row-source">{{ entry.source }}</span>
          <span class="hc-logs__row-msg" :class="{ 'hc-logs__row-msg--truncate': !expandedIds.has(entry.id) }">
            {{ entry.message }}
          </span>
        </div>

        <div v-if="expandedIds.has(entry.id)" class="hc-logs__detail">
          <div class="hc-logs__detail-meta">
            <span>ID: {{ entry.id }}</span>
            <span>Source: {{ entry.source || '-' }}</span>
            <span>Domain: {{ entry.domain || '-' }}</span>
            <span>Level: {{ entry.level }}</span>
            <span>Time: {{ entry.timestamp }}</span>
          </div>
          <pre class="hc-logs__detail-body">{{ entry.message }}</pre>
        </div>
      </div>

      <div v-if="logsStore.filteredEntries.length === 0" class="hc-logs__empty">
        <ScrollText :size="40" class="hc-logs__empty-icon" />
        <p>{{ logsStore.connected ? t('logs.connected') : t('logs.disconnected') }}</p>
      </div>
    </div>

    <!-- 4. Status bar (minimal counts, no duplication) -->
    <div class="hc-logs__statusbar">
      <span>{{ logsStore.filteredEntries.length }} {{ t('logs.entryUnit', '条日志') }}</span>
      <span v-if="logsStore.stats" class="hc-logs__statusbar-sep">{{ logsStore.stats.requests_per_minute?.toFixed(1) || 0 }} req/min</span>
    </div>
  </div>
</template>

<style scoped>
/* ─── Page layout ─── */
.hc-logs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ─── Toolbar action buttons (icon-only, 28x28) ─── */
.hc-logs__action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.hc-logs__action-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-logs__action-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.hc-logs__action-btn--spinning svg {
  animation: hc-log-spin 1s linear infinite;
}

/* ─── Header filter controls ─── */
.hc-logs__header-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-logs__domain {
  height: 32px;
  min-width: 120px;
  padding: 0 28px 0 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  box-sizing: border-box;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
  -webkit-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2398989D' stroke-width='1.2' fill='none'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.hc-logs__domain:focus {
  border-color: var(--hc-accent);
}

.hc-logs__search {
  width: 200px;
}

.hc-logs__search :deep(.hc-search) {
  width: 200px;
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

.hc-logs__autoscroll input {
  accent-color: var(--hc-accent);
  width: 13px;
  height: 13px;
}

/* ─── Log stream ─── */
.hc-logs__stream {
  flex: 1;
  overflow-y: auto;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
}

.hc-logs__entry {
  border-bottom: 0.5px solid var(--hc-divider, rgba(255, 255, 255, 0.04));
}

.hc-logs__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 5px 20px;
  cursor: pointer;
  transition: background 0.12s;
}

.hc-logs__row:hover {
  background: var(--hc-bg-hover);
}

.hc-logs__row-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--hc-text-muted);
}

.hc-logs__row-time {
  flex-shrink: 0;
  width: 56px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  padding-top: 1px;
}

.hc-logs__row-level {
  flex-shrink: 0;
  width: 42px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding-top: 1px;
}

/* Level colors using CSS variables for consistency */
.hc-logs__row-level--debug { color: var(--hc-text-muted); }
.hc-logs__row-level--info  { color: var(--hc-accent, #007AFF); }
.hc-logs__row-level--warn  { color: var(--hc-warning, #FF9F0A); }
.hc-logs__row-level--error { color: var(--hc-error, #FF3B30); }

.hc-logs__row-source {
  flex-shrink: 0;
  width: 80px;
  font-size: 10px;
  color: var(--hc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-top: 1px;
}

.hc-logs__row-msg {
  flex: 1;
  min-width: 0;
  color: var(--hc-text-primary);
  word-break: break-all;
}

.hc-logs__row-msg--truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── Expanded detail ─── */
.hc-logs__detail {
  padding: 6px 20px 8px 52px;
  background: var(--hc-bg-hover);
}

.hc-logs__detail-meta {
  display: flex;
  gap: 16px;
  font-size: 10px;
  color: var(--hc-text-muted);
}

.hc-logs__detail-body {
  margin: 4px 0 0;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--hc-text-primary);
}

/* ─── Empty state ─── */
.hc-logs__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--hc-text-muted);
}

.hc-logs__empty-icon {
  opacity: 0.3;
  margin-bottom: 12px;
}

.hc-logs__empty p {
  font-size: 13px;
}

/* ─── Status bar ─── */
.hc-logs__statusbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px;
  height: 26px;
  border-top: 0.5px solid var(--hc-divider);
  background: var(--hc-bg-sidebar);
  font-size: 11px;
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.hc-logs__statusbar-sep::before {
  content: '·';
  margin-right: 16px;
}

/* ─── Animation ─── */
@keyframes hc-log-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ─── Responsive ─── */
@media (max-width: 1100px) {
  .hc-logs__header-filters {
    flex-wrap: wrap;
  }

  .hc-logs__search {
    width: 160px;
  }
}
</style>
