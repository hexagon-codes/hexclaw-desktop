<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import {
  MessageSquare, Bot, Clock, BookOpen, Brain, Server,
  ArrowUpRight, Activity,
  RefreshCw,
} from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()

// Dashboard stats (fetched from backend)
const stats = ref({
  totalSessions: 0,
  totalMessages: 0,
  activeAgents: 0,
  knowledgeDocs: 0,
  memoryEntries: 0,
  mcpServers: 0,
  tasksRunToday: 0,
  todayMessages: 0,
})

const loading = ref(true)
const lastRefreshed = ref<Date | null>(null)
const countdown = ref(30)
let refreshTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null

// Recent activity
interface RecentActivity {
  id: string
  title: string
  type: 'chat' | 'agent' | 'task'
  time: string
}
const recentActivity = ref<RecentActivity[]>([])

const quickActions = computed(() => [
  { icon: MessageSquare, label: t('nav.chat'), desc: t('dashboard.startNewChat'), path: '/chat', color: 'var(--hc-accent)' },
  { icon: Bot, label: t('nav.agents'), desc: t('dashboard.manageAgents'), path: '/agents', color: '#10b981' },
  { icon: Clock, label: t('nav.tasks'), desc: t('dashboard.viewTasks'), path: '/tasks', color: '#f59e0b' },
  { icon: BookOpen, label: t('nav.knowledge'), desc: t('dashboard.manageKnowledge'), path: '/knowledge', color: '#8b5cf6' },
])

const lastRefreshedText = computed(() => {
  if (!lastRefreshed.value) return ''
  const h = lastRefreshed.value.getHours().toString().padStart(2, '0')
  const m = lastRefreshed.value.getMinutes().toString().padStart(2, '0')
  const s = lastRefreshed.value.getSeconds().toString().padStart(2, '0')
  return `${h}:${m}:${s}`
})

async function fetchStats() {
  try {
    // Try fetch stats from backend
    const { apiGet } = await import('@/api/client')
    try {
      const res = await apiGet<Record<string, unknown>>('/api/v1/stats')
      if (res) Object.assign(stats.value, res)
    } catch {
      // Stats endpoint may not exist yet, use defaults
    }

    // Fetch individual counts as fallback
    try {
      const { dbGetSessions } = await import('@/db/chat')
      const sessions = await dbGetSessions()
      stats.value.totalSessions = sessions?.length || 0

      // Build recent activity from sessions
      const recent = (sessions || []).slice(0, 5).map((s) => ({
        id: s.id,
        title: s.title || '未命名会话',
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
  } finally {
    loading.value = false
    lastRefreshed.value = new Date()
    countdown.value = 30
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshTimer = setInterval(() => {
    fetchStats()
  }, 30000)
  countdownTimer = setInterval(() => {
    countdown.value = Math.max(0, countdown.value - 1)
  }, 1000)
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

function handleManualRefresh() {
  loading.value = true
  fetchStats()
  startAutoRefresh()
}

function formatActivityTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return t('dashboard.justNow')
    if (mins < 60) return t('dashboard.minutesAgo', { n: mins })
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t('dashboard.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    return t('dashboard.daysAgo', { n: days })
  } catch {
    return ''
  }
}

onMounted(async () => {
  await fetchStats()
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})

function navigateTo(path: string) {
  router.push(path)
}
</script>

<template>
  <div class="hc-dash">
    <PageHeader :title="t('dashboard.title')" :description="t('dashboard.description')">
      <template #actions>
        <div class="flex items-center gap-3">
          <span v-if="lastRefreshedText" class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
            更新于 {{ lastRefreshedText }} ({{ countdown }}s)
          </span>
          <button
            class="p-1.5 rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            :style="{ color: 'var(--hc-text-secondary)' }"
            :disabled="loading"
            @click="handleManualRefresh"
          >
            <RefreshCw :size="15" :class="{ 'animate-spin': loading }" />
          </button>
        </div>
      </template>
    </PageHeader>

    <div class="hc-dash__body">
      <!-- Stats cards -->
      <div class="hc-dash__stats">
        <div class="hc-dash__stat">
          <div class="hc-dash__stat-icon" style="background: rgba(74,144,217,0.12); color: var(--hc-accent);">
            <MessageSquare :size="18" />
          </div>
          <div>
            <div class="hc-dash__stat-value">{{ stats.totalSessions }}</div>
            <div class="hc-dash__stat-label">{{ t('dashboard.sessions') }}</div>
          </div>
        </div>
        <div class="hc-dash__stat">
          <div class="hc-dash__stat-icon" style="background: rgba(16,185,129,0.12); color: #10b981;">
            <Bot :size="18" />
          </div>
          <div>
            <div class="hc-dash__stat-value">{{ stats.activeAgents }}</div>
            <div class="hc-dash__stat-label">{{ t('dashboard.agents') }}</div>
          </div>
        </div>
        <div class="hc-dash__stat">
          <div class="hc-dash__stat-icon" style="background: rgba(139,92,246,0.12); color: #8b5cf6;">
            <Brain :size="18" />
          </div>
          <div>
            <div class="hc-dash__stat-value">{{ stats.memoryEntries }}</div>
            <div class="hc-dash__stat-label">{{ t('dashboard.memoryEntries') }}</div>
          </div>
        </div>
        <div class="hc-dash__stat">
          <div class="hc-dash__stat-icon" style="background: rgba(245,158,11,0.12); color: #f59e0b;">
            <Server :size="18" />
          </div>
          <div>
            <div class="hc-dash__stat-value">{{ stats.mcpServers }}</div>
            <div class="hc-dash__stat-label">{{ t('dashboard.mcpServers') }}</div>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <h3 class="hc-dash__section-title">{{ t('dashboard.recentActivity') }}</h3>
      <div v-if="recentActivity.length > 0" class="hc-dash__activity">
        <div
          v-for="item in recentActivity"
          :key="item.id"
          class="hc-dash__activity-item"
          @click="navigateTo('/chat')"
        >
          <div class="hc-dash__activity-icon">
            <MessageSquare :size="14" />
          </div>
          <div class="hc-dash__activity-info">
            <span class="hc-dash__activity-title">{{ item.title }}</span>
            <span class="hc-dash__activity-time">{{ formatActivityTime(item.time) }}</span>
          </div>
        </div>
      </div>
      <div v-else class="hc-dash__activity-empty">
        <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('dashboard.noActivity') }}</span>
      </div>

      <!-- Quick actions -->
      <h3 class="hc-dash__section-title">{{ t('dashboard.quickActions') }}</h3>
      <div class="hc-dash__actions">
        <button
          v-for="action in quickActions"
          :key="action.path"
          class="hc-dash__action hc-card"
          @click="navigateTo(action.path)"
        >
          <div class="hc-dash__action-icon" :style="{ background: action.color + '18', color: action.color }">
            <component :is="action.icon" :size="20" />
          </div>
          <div class="hc-dash__action-info">
            <span class="hc-dash__action-label">{{ action.label }}</span>
            <span class="hc-dash__action-desc">{{ action.desc }}</span>
          </div>
          <ArrowUpRight :size="14" class="hc-dash__action-arrow" />
        </button>
      </div>

      <!-- System status -->
      <h3 class="hc-dash__section-title">{{ t('dashboard.systemStatus') }}</h3>
      <div class="hc-dash__status-row">
        <div class="hc-dash__status-item">
          <Activity :size="14" />
          <span>{{ t('dashboard.backendEngine') }}</span>
          <span
            class="hc-dash__status-dot"
            :class="appStore.sidecarReady ? 'hc-dash__status-dot--ok' : 'hc-dash__status-dot--err'"
          />
          <span class="hc-dash__status-text">
            {{ appStore.sidecarReady ? t('dashboard.running') : t('dashboard.disconnected') }}
          </span>
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
  overflow-y: auto;
  padding: 0 24px 24px;
  max-width: 900px;
}

.hc-dash__stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 28px;
}

.hc-dash__stat {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
}

.hc-dash__stat-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--hc-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-dash__stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}

.hc-dash__stat-label {
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-dash__section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-secondary);
  margin: 0 0 12px;
}

/* Recent Activity */
.hc-dash__activity {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 28px;
}

.hc-dash__activity-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.hc-dash__activity-item:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-dash__activity-icon {
  color: var(--hc-accent);
  flex-shrink: 0;
}

.hc-dash__activity-info {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

.hc-dash__activity-title {
  font-size: 13px;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-dash__activity-time {
  font-size: 11px;
  color: var(--hc-text-muted);
  flex-shrink: 0;
  margin-left: 12px;
}

.hc-dash__activity-empty {
  padding: 16px;
  text-align: center;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  margin-bottom: 28px;
}

.hc-dash__actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 28px;
}

.hc-dash__action {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  text-align: left;
  border: 1px solid var(--hc-border);
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}

.hc-dash__action:hover {
  border-color: var(--hc-accent-subtle);
  box-shadow: var(--hc-shadow-md);
  transform: translateY(-1px);
}

.hc-dash__action-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--hc-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-dash__action-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.hc-dash__action-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-dash__action-desc {
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-dash__action-arrow {
  color: var(--hc-text-muted);
  opacity: 0;
  transition: opacity 0.15s;
}

.hc-dash__action:hover .hc-dash__action-arrow {
  opacity: 1;
}

.hc-dash__status-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-dash__status-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--hc-text-secondary);
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
}

.hc-dash__status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-left: auto;
}

.hc-dash__status-dot--ok {
  background: var(--hc-success);
  box-shadow: 0 0 6px var(--hc-success);
}

.hc-dash__status-dot--err {
  background: var(--hc-error);
  box-shadow: 0 0 6px var(--hc-error);
}

.hc-dash__status-text {
  font-size: 12px;
  min-width: 50px;
}
</style>
