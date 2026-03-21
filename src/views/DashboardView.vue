<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { RefreshCw } from 'lucide-vue-next'
import PageToolbar from '@/components/common/PageToolbar.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()

const dashTab = ref('today')
const dashTabs = computed(() => [
  { key: 'today', label: t('dashboard.today', 'Today') },
  { key: 'week', label: t('dashboard.lastWeek', 'Last 7 Days') },
  { key: 'system', label: t('dashboard.system', 'System') },
])

const stats = ref({
  totalSessions: 0,
  totalMessages: 0,
  activeAgents: 0,
  knowledgeDocs: 0,
  memoryEntries: 0,
  mcpServers: 0,
  tasksRunToday: 0,
  todayMessages: 0,
  imChannels: 0,
})

const loading = ref(true)
const lastRefreshed = ref<Date | null>(null)
const countdown = ref(30)
let refreshTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null

interface RecentActivity {
  id: string
  title: string
  type: 'chat' | 'agent' | 'task'
  time: string
}
const recentActivity = ref<RecentActivity[]>([])

const lastRefreshedText = computed(() => {
  if (!lastRefreshed.value) return ''
  const h = lastRefreshed.value.getHours().toString().padStart(2, '0')
  const m = lastRefreshed.value.getMinutes().toString().padStart(2, '0')
  const s = lastRefreshed.value.getSeconds().toString().padStart(2, '0')
  return `${h}:${m}:${s}`
})

async function fetchStats() {
  try {
    const { apiGet } = await import('@/api/client')
    try {
      const res = await apiGet<Record<string, unknown>>('/api/v1/stats')
      if (res) Object.assign(stats.value, res)
    } catch {}

    try {
      const { dbGetSessions } = await import('@/db/chat')
      const sessions = await dbGetSessions()
      stats.value.totalSessions = sessions?.length || 0
      const recent = (sessions || []).slice(0, 3).map((s) => ({
        id: s.id,
        title: s.title || t('chat.newSessionDefault'),
        type: 'chat' as const,
        time: s.updated_at,
      }))
      recentActivity.value = recent
    } catch {}

    try {
      const { getRoles } = await import('@/api/agents')
      const agentRes = await getRoles()
      stats.value.activeAgents = agentRes.roles?.length || 0
    } catch {}

    try {
      const { getMcpServers } = await import('@/api/mcp')
      const mcpRes = await getMcpServers()
      stats.value.mcpServers = mcpRes.servers?.length || 0
    } catch {}

    try {
      const { getMemory } = await import('@/api/memory')
      const memRes = await getMemory()
      stats.value.memoryEntries = Object.keys(memRes.content || {}).length
    } catch {}

    try {
      const { getDocuments } = await import('@/api/knowledge')
      const kRes = await getDocuments()
      stats.value.knowledgeDocs = kRes.documents?.length || 0
    } catch {}

    try {
      const { getIMInstances } = await import('@/api/im-channels')
      const imRes = await getIMInstances()
      stats.value.imChannels = imRes?.length || 0
    } catch {}
  } finally {
    loading.value = false
    lastRefreshed.value = new Date()
    countdown.value = 30
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshTimer = setInterval(() => fetchStats(), 30000)
  countdownTimer = setInterval(() => {
    countdown.value = Math.max(0, countdown.value - 1)
  }, 1000)
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
}

function handleManualRefresh() {
  loading.value = true
  fetchStats()
  startAutoRefresh()
}

function formatActivityTime(iso: string): string {
  try {
    const d = new Date(iso)
    const diff = Date.now() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return t('dashboard.justNow')
    if (mins < 60) return t('dashboard.minutesAgo', { n: mins })
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t('dashboard.hoursAgo', { n: hours })
    return t('dashboard.daysAgo', { n: Math.floor(hours / 24) })
  } catch { return '' }
}

onMounted(async () => {
  await fetchStats()
  startAutoRefresh()
})

onUnmounted(() => stopAutoRefresh())

function navigateTo(path: string) {
  router.push(path)
}
</script>

<template>
  <div class="hc-dash">
    <!-- Toolbar -->
    <PageToolbar>
      <template #tabs>
        <SegmentedControl v-model="dashTab" :segments="dashTabs" />
      </template>
      <template #actions>
        <button class="hc-btn hc-btn-ghost" @click="navigateTo('/chat')">
          {{ t('dashboard.newChat', 'New Chat') }}
        </button>
        <button
          class="hc-btn hc-btn-ghost"
          :disabled="loading"
          @click="handleManualRefresh"
        >
          <RefreshCw :size="14" :class="{ 'hc-spin-icon': loading }" />
        </button>
      </template>
    </PageToolbar>

    <!-- Header -->
    <PageHeader
      :eyebrow="t('dashboard.eyebrow', 'overview workspace')"
      :title="t('dashboard.heroTitle', 'Built for real tasks, not just chat')"
      :description="t('dashboard.heroDesc', 'A local-first AI agent desktop that unifies models, knowledge, MCP tools, and workflow orchestration.')"
      :status="appStore.sidecarReady ? t('dashboard.systemHealthy', 'System Healthy') : t('dashboard.systemDown', 'Disconnected')"
      :status-variant="appStore.sidecarReady ? 'success' : 'error'"
      :timestamp="lastRefreshedText ? `updated ${lastRefreshedText}` : undefined"
    />

    <!-- Content -->
    <div class="hc-dash__body">
      <div class="hc-dash__grid-two">
        <div class="hc-dash__card">
          <div class="hc-dash__card-body">
            <div class="hc-dash__card-title">{{ t('dashboard.coreCapabilities', 'Core Capabilities') }}</div>
            <div class="hc-dash__notes">
              <div class="hc-dash__note hc-dash__note--highlight" @click="navigateTo('/channels')">
                <div class="hc-dash__note-title">{{ t('dashboard.imChannels', 'IM Channels — Feishu / DingTalk / Discord / Telegram') }}</div>
              </div>
              <div class="hc-dash__note">
                <div class="hc-dash__note-title">{{ t('dashboard.localDeploy', 'Local deployment, private data') }}</div>
              </div>
              <div class="hc-dash__note">
                <div class="hc-dash__note-title">{{ t('dashboard.agentEngine', 'In-house agent engine') }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="hc-dash__card">
          <div class="hc-dash__card-body">
            <div class="hc-dash__metrics">
              <div class="hc-dash__metric">
                <div>
                  <div class="hc-dash__metric-title">{{ t('dashboard.modelProviders', 'Model Providers') }}</div>
                  <div class="hc-dash__metric-sub">OpenAI / Claude / DeepSeek / Gemini / Ollama</div>
                </div>
                <div class="hc-dash__metric-value">{{ String(stats.mcpServers || 5).padStart(2, '0') }}</div>
              </div>
              <div class="hc-dash__metric">
                <div>
                  <div class="hc-dash__metric-title">{{ t('dashboard.activeAgents', 'Active Agents') }}</div>
                  <div class="hc-dash__metric-sub">{{ t('dashboard.agentsSummary', { n: stats.activeAgents }) }}</div>
                </div>
                <div class="hc-dash__metric-value">{{ String(stats.activeAgents || 0).padStart(2, '0') }}</div>
              </div>
              <div class="hc-dash__metric" @click="navigateTo('/channels')" style="cursor: pointer">
                <div>
                  <div class="hc-dash__metric-title">{{ t('dashboard.imChannelsMetric', 'IM Channels') }}</div>
                  <div class="hc-dash__metric-sub">Feishu / DingTalk / Discord / Telegram</div>
                </div>
                <div class="hc-dash__metric-value">{{ String(stats.imChannels || 0).padStart(2, '0') }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="hc-dash__grid-equal">
        <div class="hc-dash__card">
          <div class="hc-dash__card-body">
            <div class="hc-dash__card-title">{{ t('dashboard.realWorkflows', 'Real Workflows') }}</div>
          </div>
          <div class="hc-dash__list">
            <div class="hc-dash__list-item" @click="navigateTo('/channels')">
              <div class="hc-dash__list-title">{{ t('dashboard.imWorkflow', 'Agent responds via IM channels') }}</div>
              <span class="hc-dash__badge hc-dash__badge--purple">{{ t('dashboard.channels', 'Channels') }}</span>
            </div>
            <div class="hc-dash__list-item" @click="navigateTo('/automation')">
              <div class="hc-dash__list-title">{{ t('dashboard.multiStepTask', 'Run multi-step research') }}</div>
              <span class="hc-dash__badge hc-dash__badge--blue">{{ t('dashboard.orchestration', 'Orchestration') }}</span>
            </div>
            <div class="hc-dash__list-item" @click="navigateTo('/chat')">
              <div class="hc-dash__list-title">{{ t('dashboard.localFiles', 'Work with local files') }}</div>
              <span class="hc-dash__badge hc-dash__badge--green">{{ t('dashboard.local', 'Local') }}</span>
            </div>
          </div>
        </div>

        <div class="hc-dash__card">
          <div class="hc-dash__card-body">
            <div class="hc-dash__card-title">{{ t('dashboard.runtimeCapabilities', 'Runtime Capabilities') }}</div>
          </div>
          <div class="hc-dash__list">
            <div class="hc-dash__list-item" @click="navigateTo('/settings')">
              <div class="hc-dash__list-title">{{ t('dashboard.localRuntime', 'Local-first runtime') }}</div>
              <span class="hc-dash__badge hc-dash__badge--green">{{ t('dashboard.enabled', 'Enabled') }}</span>
            </div>
            <div class="hc-dash__list-item" @click="navigateTo('/chat')">
              <div class="hc-dash__list-title">{{ t('dashboard.unifiedModel', 'Unified model layer') }}</div>
              <span class="hc-dash__badge hc-dash__badge--blue">{{ t('dashboard.hotSwitch', 'Hot Switch') }}</span>
            </div>
            <div class="hc-dash__list-item" @click="navigateTo('/logs')">
              <div class="hc-dash__list-title">{{ t('dashboard.observability', 'End-to-end observability') }}</div>
              <span class="hc-dash__badge hc-dash__badge--amber">{{ t('dashboard.traceable', 'Traceable') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-dash {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-dash__body {
  flex: 1;
  overflow: hidden;
  padding: 0 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.hc-dash__grid-two {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 8px;
  flex-shrink: 1;
  min-height: 0;
  overflow: hidden;
}

.hc-dash__grid-two > .hc-dash__card {
  min-height: 0;
  overflow: hidden;
}

.hc-dash__grid-two > .hc-dash__card > .hc-dash__card-body {
  overflow: hidden;
}

.hc-dash__grid-equal {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.hc-dash__grid-equal > .hc-dash__card {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.hc-dash__grid-equal > .hc-dash__card > .hc-dash__list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* ── Card ── */
.hc-dash__card {
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  border-radius: 14px;
  box-shadow: var(--hc-shadow-sm);
  overflow: hidden;
}

.hc-dash__card-body {
  padding: 10px 14px;
}

.hc-dash__card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--hc-text-primary);
}

.hc-dash__card-desc {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}

/* ── Notes ── */
.hc-dash__notes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  overflow: hidden;
}

.hc-dash__note {
  border-radius: 8px;
  background: var(--hc-bg-hover);
  padding: 6px 10px;
  border: 1px solid transparent;
  transition: transform 0.15s, background 0.15s;
}

.hc-dash__note:hover {
  transform: translateY(-1px);
  background: var(--hc-accent-subtle);
}

.hc-dash__note--highlight {
  background: rgba(147, 51, 234, 0.08);
  border-color: rgba(147, 51, 234, 0.2);
  cursor: pointer;
}

.hc-dash__note--highlight:hover {
  background: rgba(147, 51, 234, 0.14);
}

.hc-dash__note-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-dash__note-desc {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--hc-text-muted);
}

/* ── Metrics ── */
.hc-dash__metrics {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-dash__metric {
  border-radius: 8px;
  background: var(--hc-bg-hover);
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  border: 1px solid transparent;
  transition: transform 0.15s, background 0.15s;
}

.hc-dash__metric:hover {
  transform: translateY(-1px);
  background: var(--hc-accent-subtle);
}

.hc-dash__metric-title {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-dash__metric-sub {
  margin-top: 2px;
  font-size: 10px;
  color: var(--hc-text-secondary);
}

.hc-dash__metric-value {
  font-size: 20px;
  font-family: 'SF Mono', 'Menlo', monospace;
  color: var(--hc-text-primary);
  font-weight: 800;
}

/* ── List ── */
.hc-dash__list {
  padding: 4px 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hc-dash__list-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform 0.15s, background 0.15s;
}

.hc-dash__list-item:hover {
  transform: translateY(-1px);
  background: var(--hc-accent-subtle);
}

.hc-dash__list-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-dash__list-desc {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--hc-text-muted);
}

/* ── Badges ── */
.hc-dash__badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  flex-shrink: 0;
  align-self: center;
}

.hc-dash__badge--blue {
  background: rgba(74, 144, 217, 0.12);
  color: var(--hc-accent);
}

.hc-dash__badge--green {
  background: rgba(50, 213, 131, 0.12);
  color: var(--hc-success);
}

.hc-dash__badge--amber {
  background: rgba(240, 180, 41, 0.12);
  color: var(--hc-warning);
}

.hc-dash__badge--purple {
  background: rgba(147, 51, 234, 0.12);
  color: #9333ea;
}

/* ── Empty ── */
.hc-dash__empty {
  padding: 12px;
  text-align: center;
  font-size: 11px;
  color: var(--hc-text-muted);
}

/* ── Spin ── */
.hc-spin-icon {
  animation: hc-spin 1s linear infinite;
}
</style>
