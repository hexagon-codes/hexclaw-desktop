<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatLogTime } from '@/utils/time'
import { ScrollText, Eraser, Download, RefreshCw, Search, Copy, X, ArrowDown } from 'lucide-vue-next'
import { useLogsStore } from '@/stores/logs'
import { useToast } from '@/composables/useToast'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import { saveBlobInApp } from '@/utils/download'
import { isTauri } from '@/utils/platform'
import type { LogEntry } from '@/types'

const { t } = useI18n()
const toast = useToast()
const logsStore = useLogsStore()

// ── 级别分段（计数集中在 store.levelCounts，Vue 缓存，仅 entries 变化时重算）──
const levelTabs = computed(() => [
  { key: '', label: `${t('logs.all')} (${logsStore.entries.length})` },
  { key: 'debug', label: `Debug (${logsStore.levelCounts.debug})` },
  { key: 'info', label: `Info (${logsStore.levelCounts.info})` },
  { key: 'warn', label: `Warn (${logsStore.levelCounts.warn})` },
  { key: 'error', label: `Error (${logsStore.levelCounts.error})` },
])
const activeLevel = ref(logsStore.filter.level || '')

// ── 子系统（domain）过滤：静态 5 桶，对齐后端 inferLogDomain(source) 的固定枚举。
//    选项列表写死 → 永不闪/不丢；徽标计数取自实时缓冲（store.domainCounts）。──
const DOMAINS = ['engine', 'integration', 'automation', 'chat', 'knowledge'] as const
const DOMAIN_FALLBACK: Record<string, string> = {
  engine: '引擎',
  integration: '集成',
  automation: '自动化',
  chat: '对话',
  knowledge: '知识库',
}
const domainOptions = computed(() => [
  { value: '', label: t('logs.allDomains', '全部域') },
  ...DOMAINS.map((d) => ({
    value: d,
    label: `${t(`logs.domain.${d}`, DOMAIN_FALLBACK[d]!)}${logsStore.domainCounts[d] ? ` (${logsStore.domainCounts[d]})` : ''}`,
  })),
])
const selectedDomain = computed<string>({
  get: () => logsStore.filter.domain || '',
  set: (v) => logsStore.setFilter({ domain: v || undefined }),
})

// ── 展示数据：history 模式 = 服务端检索结果；live 模式 = 本地过滤缓冲 ──
const displayed = computed<LogEntry[]>(() => logsStore.displayedEntries)

// ─────────────────────────── 虚拟滚动 ───────────────────────────
// 行等高（折叠单行，详情移入抽屉），故定高窗口化即可，无需测量/第三方库。
const ROW_H = 26
const OVERSCAN = 8
const viewport = ref<HTMLDivElement>()
const scrollTop = ref(0)
const viewportH = ref(0)

const totalHeight = computed(() => displayed.value.length * ROW_H)
const range = computed(() => {
  // viewportH 未知（测试 / 初始挂载）时回退为「全量渲染」，保证可测且不丢行
  if (viewportH.value <= 0) return { start: 0, end: displayed.value.length }
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN)
  const visible = Math.ceil(viewportH.value / ROW_H) + OVERSCAN * 2
  return { start, end: Math.min(displayed.value.length, start + visible) }
})
const visibleEntries = computed(() => displayed.value.slice(range.value.start, range.value.end))
const offsetY = computed(() => range.value.start * ROW_H)

let ro: ResizeObserver | null = null
function measureViewport() {
  if (viewport.value) viewportH.value = viewport.value.clientHeight
}

// ── 跟随底部（live tail）+ 「新日志」浮标 ──
const following = ref(true)
const hasNew = ref(false)

function jumpToBottom() {
  following.value = true
  hasNew.value = false
  nextTick(() => {
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
  })
}

function onScroll() {
  if (!viewport.value) return
  const { scrollTop: st, scrollHeight, clientHeight } = viewport.value
  scrollTop.value = st
  following.value = scrollHeight - st - clientHeight < 40
  if (following.value) hasNew.value = false
}

// 新日志到达：跟随中则贴底；否则亮起浮标（history 模式不自动滚）
watch(
  () => displayed.value.length,
  (n, old) => {
    if (logsStore.mode === 'history') return
    if (following.value) jumpToBottom()
    else if (n > old) hasNew.value = true
  },
)

// ─────────────────────────── 详情抽屉 ───────────────────────────
const selectedId = ref<string | null>(null)
const selected = computed<LogEntry | null>(
  () => displayed.value.find((e) => e.id === selectedId.value) ?? null,
)
function selectRow(e: LogEntry) {
  selectedId.value = selectedId.value === e.id ? null : e.id
}
function closeDetail() {
  selectedId.value = null
}
// 结构化字段（fields）→ KV 列表
const selectedFields = computed<[string, unknown][]>(() =>
  selected.value?.fields ? Object.entries(selected.value.fields) : [],
)

// ─────────────────────────── 键盘导航（a11y）───────────────────────────
function onKeydown(e: KeyboardEvent) {
  const list = displayed.value
  if (e.key === 'Escape') { selectedId.value = null; return }
  if (!list.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  e.preventDefault()
  const cur = list.findIndex((x) => x.id === selectedId.value)
  const next =
    e.key === 'ArrowDown'
      ? Math.min(list.length - 1, cur + 1)
      : Math.max(0, cur < 0 ? list.length - 1 : cur - 1)
  selectedId.value = list[next]!.id
  scrollIndexIntoView(next)
}
function scrollIndexIntoView(i: number) {
  if (!viewport.value) return
  const top = i * ROW_H
  const bottom = top + ROW_H
  const vt = viewport.value.scrollTop
  const vh = viewport.value.clientHeight
  if (top < vt) viewport.value.scrollTop = top
  else if (bottom > vt + vh) viewport.value.scrollTop = bottom - vh
}

// ─────────────────────────── 复制 ───────────────────────────
async function copy(text: string) {
  try {
    await navigator.clipboard?.writeText(text)
    toast.success(t('logs.copied', '已复制'))
  } catch {
    toast.error(t('logs.copyFailed', '复制失败'))
  }
}
function logLine(e: LogEntry): string {
  return `[${formatLogTime(e.timestamp)}] [${e.level.toUpperCase()}] [${e.source || '-'}] ${e.message}`
}

// ─────────────────────────── 历史检索 ───────────────────────────
function searchHistory() {
  void logsStore.searchHistory({
    keyword: logsStore.filter.keyword,
    level: logsStore.filter.level,
    domain: logsStore.filter.domain,
  })
}
function searchByTrace(traceId: string) {
  void logsStore.searchHistory({ keyword: traceId })
}
// 改动级别 / 关键词即退出历史模式，回到实时（避免双重过滤语义混淆）
watch([activeLevel, () => logsStore.filter.keyword, () => logsStore.filter.domain], () => {
  if (logsStore.mode === 'history') logsStore.exitHistory()
})
watch(activeLevel, (level) => {
  logsStore.setFilter({ level: level || undefined })
})

// ─────────────────────────── 刷新 / 清空 / 导出 ───────────────────────────
const refreshing = ref(false)
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
function waitForReconnect(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (logsStore.connected) { resolve(); return }
    const stop = watch(() => logsStore.connected, (c) => { if (c) { cleanup(); resolve() } })
    const timer = window.setTimeout(() => { cleanup(); resolve() }, timeoutMs)
    function cleanup() { stop(); window.clearTimeout(timer) }
  })
}
async function refreshLogs() {
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

function clearLogs() {
  logsStore.clear()
  selectedId.value = null
  hasNew.value = false
}

function exportLogs() {
  const entries = displayed.value
  if (entries.length === 0) return
  const blob = new Blob([entries.map(logLine).join('\n')], { type: 'text/plain;charset=utf-8' })
  const filename = `hexclaw-logs-${new Date().toISOString().slice(0, 10)}.log`
  if (isTauri()) {
    void saveBlobInApp(blob, filename)
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────── 生命周期 ───────────────────────────
onMounted(() => {
  logsStore.connect()
  logsStore.loadStats()
  nextTick(() => {
    measureViewport()
    if (viewport.value && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measureViewport)
      ro.observe(viewport.value)
    }
    jumpToBottom()
  })
})
onUnmounted(() => {
  logsStore.disconnect()
  ro?.disconnect()
})
</script>

<template>
  <div class="hc-logs-page">
    <!-- 工具栏：级别分段 + 搜索（左）｜历史检索 / 导出 / 刷新 / 清空（右）。域过滤已下线，
         source 收敛为唯一分类轴（行内展示 + 全文搜索覆盖）。 -->
    <PageToolbar>
      <template #tabs>
        <SegmentedControl
          v-model="activeLevel"
          :segments="levelTabs.map(l => ({ key: l.key, label: l.label }))"
        />
        <HcSelect
          v-model="selectedDomain"
          class="hc-logs__domain"
          :options="domainOptions"
          :aria-label="t('logs.allDomains', '全部域')"
        />
        <SearchInput
          class="hc-logs__search"
          :model-value="logsStore.filter.keyword || ''"
          :placeholder="t('logs.searchPlaceholder')"
          @update:model-value="logsStore.setFilter({ keyword: $event || undefined })"
        />
      </template>
      <template #actions>
        <button
          class="hc-logs__action-btn"
          :class="{ 'hc-logs__action-btn--active': logsStore.mode === 'history' }"
          :title="t('logs.searchHistory', '搜索全部历史')"
          :aria-label="t('logs.searchHistory', '搜索全部历史')"
          @click="searchHistory"
        >
          <Search :size="14" />
        </button>
        <button class="hc-logs__action-btn" :title="t('logs.exportLogs', '导出日志')" :aria-label="t('logs.exportLogs', '导出日志')" @click="exportLogs">
          <Download :size="14" />
        </button>
        <button
          class="hc-logs__action-btn"
          :class="{ 'hc-logs__action-btn--spinning': refreshing }"
          :title="t('logs.refreshLogs', '刷新')"
          :aria-label="t('logs.refreshLogs', '刷新')"
          :disabled="refreshing"
          @click="refreshLogs"
        >
          <RefreshCw :size="14" />
        </button>
        <button class="hc-logs__action-btn" :title="t('logs.clear', '清空')" :aria-label="t('logs.clear', '清空')" @click="clearLogs">
          <Eraser :size="14" />
        </button>
      </template>
    </PageToolbar>

    <!-- 历史检索结果横幅 -->
    <div v-if="logsStore.mode === 'history'" class="hc-logs__histbar">
      <span>{{ t('logs.historyResults', '历史搜索结果') }} · {{ logsStore.historyEntries.length }} {{ t('logs.entryUnit', '条') }}</span>
      <button class="hc-logs__histbar-back" @click="logsStore.exitHistory()">
        {{ t('logs.backToLive', '返回实时') }}
      </button>
    </div>

    <!-- 日志流（虚拟滚动）。行等高，详情走底部抽屉。 -->
    <div
      ref="viewport"
      class="hc-logs__stream"
      tabindex="0"
      role="listbox"
      :aria-activedescendant="selectedId ? `log-${selectedId}` : undefined"
      @scroll="onScroll"
      @keydown="onKeydown"
    >
      <div class="hc-logs__sizer" :style="{ height: `${totalHeight}px` }">
        <div class="hc-logs__window" :style="{ transform: `translateY(${offsetY}px)` }">
          <div
            v-for="entry in visibleEntries"
            :id="`log-${entry.id}`"
            :key="entry.id"
            class="hc-logs__row"
            :class="[
              `hc-logs__row--${entry.level}`,
              { 'hc-logs__row--selected': entry.id === selectedId },
            ]"
            role="option"
            :aria-selected="entry.id === selectedId"
            @click="selectRow(entry)"
          >
            <span class="hc-logs__row-time" :title="entry.timestamp">{{ formatLogTime(entry.timestamp) }}</span>
            <span class="hc-logs__row-level" :class="`hc-logs__row-level--${entry.level}`">{{ entry.level }}</span>
            <span class="hc-logs__row-source">{{ entry.source }}</span>
            <span class="hc-logs__row-msg">{{ entry.message }}</span>
            <button
              class="hc-logs__row-copy"
              :title="t('logs.copyLine', '复制此行')"
              :aria-label="t('logs.copyLine', '复制此行')"
              @click.stop="copy(logLine(entry))"
            >
              <Copy :size="12" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="displayed.length === 0" class="hc-logs__empty">
        <ScrollText :size="40" class="hc-logs__empty-icon" />
        <p>{{ logsStore.mode === 'history'
          ? t('logs.noHistoryMatch', '无匹配的历史日志')
          : (logsStore.connected ? t('logs.connected') : t('logs.disconnected')) }}</p>
      </div>
    </div>

    <!-- 「新日志」浮标：未跟随且有新日志时出现 -->
    <button
      v-if="!following && hasNew && logsStore.mode === 'live'"
      class="hc-logs__followpill"
      @click="jumpToBottom"
    >
      <ArrowDown :size="13" />
      {{ t('logs.newLogs', '新日志') }}
    </button>

    <!-- 详情抽屉：结构化 fields + trace_id（点击可按 trace 检索）+ 复制 -->
    <div v-if="selected" class="hc-logs__drawer">
      <div class="hc-logs__drawer-head">
        <span class="hc-logs__row-level" :class="`hc-logs__row-level--${selected.level}`">{{ selected.level }}</span>
        <span class="hc-logs__drawer-time">{{ formatLogTime(selected.timestamp) }}</span>
        <span class="hc-logs__drawer-src">{{ selected.source || '-' }}<template v-if="selected.domain"> · {{ selected.domain }}</template></span>
        <span class="hc-logs__drawer-spacer" />
        <button class="hc-logs__action-btn" :title="t('logs.copyJson', '复制 JSON')" @click="copy(JSON.stringify(selected, null, 2))"><Copy :size="13" /></button>
        <button class="hc-logs__action-btn" :title="t('common.close', '关闭')" :aria-label="t('common.close', '关闭')" @click="closeDetail"><X :size="14" /></button>
      </div>
      <div class="hc-logs__drawer-body">
        <pre class="hc-logs__drawer-msg">{{ selected.message }}</pre>

        <div v-if="selected.trace_id" class="hc-logs__trace">
          <span class="hc-logs__trace-key">trace_id</span>
          <code class="hc-logs__trace-id">{{ selected.trace_id }}</code>
          <button class="hc-logs__trace-btn" @click="searchByTrace(selected.trace_id)">{{ t('logs.filterByTrace', '按此 trace 检索') }}</button>
          <button class="hc-logs__trace-btn" @click="copy(logLine(selected))">{{ t('logs.copyWholeLine', '复制整条') }}</button>
        </div>

        <table v-if="selectedFields.length" class="hc-logs__kv">
          <tbody>
            <tr v-for="[k, v] in selectedFields" :key="k">
              <td class="hc-logs__kv-key">{{ k }}</td>
              <td class="hc-logs__kv-val">{{ typeof v === 'object' ? JSON.stringify(v) : String(v) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 底部状态栏：连接态 + 条数 + 错误/警告计数（左）｜跟随（右）-->
    <div class="hc-logs__statusbar">
      <span
        class="hc-logs__status"
        :class="logsStore.connected ? 'hc-logs__status--ok' : 'hc-logs__status--err'"
      >
        {{ logsStore.connected ? t('logs.running', '运行中') : t('logs.disconnected', '已断开') }}
      </span>
      <span>{{ displayed.length }} {{ t('logs.entryUnit', '条') }}</span>
      <span class="hc-logs__statusbar-sep">
        <span class="hc-logs__count-err">{{ t('logs.levelError', '错误') }} {{ logsStore.levelCounts.error }}</span>
        ·
        <span class="hc-logs__count-warn">{{ t('logs.levelWarn', '警告') }} {{ logsStore.levelCounts.warn }}</span>
      </span>
      <span class="hc-logs__statusbar-spacer" />
      <label class="hc-logs__autoscroll">
        <input :checked="following" type="checkbox" @change="(e) => (e.target as HTMLInputElement).checked ? jumpToBottom() : (following = false)" />
        <span>{{ t('logs.follow', '跟随') }}</span>
      </label>
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
  position: relative;
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
.hc-logs__action-btn--active {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.hc-logs__action-btn--spinning svg {
  animation: hc-log-spin 1s linear infinite;
}

/* 连接状态 pill */
.hc-logs__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.hc-logs__status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.hc-logs__status--ok {
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
  color: var(--hc-success);
}
.hc-logs__status--err {
  background: color-mix(in srgb, var(--hc-error) 12%, transparent);
  color: var(--hc-error);
}

/* 子系统过滤下拉（HcSelect）：约束宽度，外观沿用 hc-input */
.hc-logs__domain {
  width: auto;
  min-width: 116px;
}
.hc-logs__domain :deep(.hc-select__trigger) {
  height: 32px;
  font-size: 12px;
}

.hc-logs__search {
  width: 200px;
}
.hc-logs__search :deep(.hc-search) {
  width: 200px;
}

/* ─── 历史检索横幅 ─── */
.hc-logs__histbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 20px;
  font-size: 12px;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  border-bottom: 0.5px solid var(--hc-divider);
  flex-shrink: 0;
}
.hc-logs__histbar-back {
  border: none;
  background: transparent;
  color: var(--hc-accent);
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

/* ─── Log stream (虚拟滚动) ─── */
.hc-logs__stream {
  flex: 1;
  overflow-y: auto;
  outline: none;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  position: relative;
}
.hc-logs__sizer {
  position: relative;
  width: 100%;
}
.hc-logs__window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}

.hc-logs__row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  padding: 0 20px;
  box-sizing: border-box;
  cursor: pointer;
  border-bottom: 0.5px solid var(--hc-divider, rgba(255, 255, 255, 0.04));
  border-left: 2px solid transparent;
  transition: background 0.12s;
}
.hc-logs__row:hover { background: var(--hc-bg-hover); }
.hc-logs__row:hover .hc-logs__row-copy { opacity: 1; }
.hc-logs__row--selected {
  background: var(--hc-accent-subtle);
  border-left-color: var(--hc-accent);
}
/* error / warn 整行视觉强调（左边框 + 淡底，扫读定位）*/
.hc-logs__row--error {
  border-left-color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 6%, transparent);
}
.hc-logs__row--warn {
  border-left-color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 6%, transparent);
}

.hc-logs__row-time {
  flex-shrink: 0;
  width: 86px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
}
.hc-logs__row-level {
  flex-shrink: 0;
  width: 42px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.hc-logs__row-level--debug { color: var(--hc-text-muted); }
.hc-logs__row-level--info  { color: var(--hc-accent, #007AFF); }
.hc-logs__row-level--warn  { color: var(--hc-warning, #FF9F0A); }
.hc-logs__row-level--error { color: var(--hc-error, #FF3B30); }

.hc-logs__row-source {
  flex-shrink: 0;
  width: 90px;
  font-size: 10px;
  color: var(--hc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hc-logs__row-msg {
  flex: 1;
  min-width: 0;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hc-logs__row-copy {
  flex-shrink: 0;
  opacity: 0;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  transition: opacity 0.12s, color 0.12s;
}
.hc-logs__row-copy:hover { color: var(--hc-accent); }

/* ─── 「新日志」浮标 ─── */
.hc-logs__followpill {
  position: absolute;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: none;
  border-radius: 999px;
  background: var(--hc-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--hc-shadow-md, 0 4px 12px rgba(0, 0, 0, 0.2));
  z-index: 5;
}

/* ─── 详情抽屉 ─── */
.hc-logs__drawer {
  flex-shrink: 0;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--hc-border);
  background: var(--hc-bg-elevated);
}
.hc-logs__drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  border-bottom: 0.5px solid var(--hc-divider);
  font-size: 11px;
  flex-shrink: 0;
}
.hc-logs__drawer-time {
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-secondary);
}
.hc-logs__drawer-src { color: var(--hc-text-muted); }
.hc-logs__drawer-spacer { flex: 1; }
.hc-logs__drawer-body {
  overflow-y: auto;
  padding: 10px 16px 14px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
}
.hc-logs__drawer-msg {
  margin: 0 0 10px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--hc-text-primary);
}

.hc-logs__trace {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
/* trace_id 标签：flex 行内独立样式，不复用表格用的 .hc-logs__kv-key（其 width:1% 会在 flex 里塌缩导致与值重叠） */
.hc-logs__trace-key {
  flex: none;
  color: var(--hc-text-muted);
  font-weight: 600;
  white-space: nowrap;
}
.hc-logs__trace-id {
  font-size: 11px;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  padding: 1px 6px;
  border-radius: 4px;
}
.hc-logs__trace-btn {
  border: none;
  background: transparent;
  color: var(--hc-accent);
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
}

.hc-logs__kv {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.hc-logs__kv td {
  padding: 3px 8px 3px 0;
  vertical-align: top;
  border-bottom: 0.5px solid var(--hc-divider);
}
.hc-logs__kv-key {
  color: var(--hc-text-muted);
  white-space: nowrap;
  width: 1%;
  font-weight: 600;
}
.hc-logs__kv-val {
  color: var(--hc-text-primary);
  word-break: break-word;
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
.hc-logs__empty p { font-size: 13px; }

/* ─── Status bar ─── */
.hc-logs__statusbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px;
  height: 34px;
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
.hc-logs__count-err { color: var(--hc-error); }
.hc-logs__count-warn { color: var(--hc-warning); }
.hc-logs__statusbar-spacer { flex: 1; }
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

/* ─── Animation ─── */
@keyframes hc-log-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
