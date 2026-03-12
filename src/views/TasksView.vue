<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Plus, Play, Pause, Trash2, Pencil, X, Save, HeartPulse, Activity } from 'lucide-vue-next'
import { getCronJobs, createCronJob, updateCronJob, deleteCronJob, triggerCronJob, type CronJob, type CronJobInput } from '@/api/tasks'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'

const { t } = useI18n()

const jobs = ref<CronJob[]>([])
const loading = ref(true)
const activeTab = ref<'cron' | 'heartbeat'>('cron')
const showForm = ref(false)
const editingJob = ref<CronJob | null>(null)

const form = ref<CronJobInput>({
  name: '',
  description: '',
  cron_expr: '',
  agent_id: '',
  prompt: '',
})

onMounted(async () => {
  try {
    const res = await getCronJobs()
    jobs.value = res.jobs || []
  } catch (e) {
    console.error('加载定时任务失败:', e)
  } finally {
    loading.value = false
  }
})

function openCreateForm() {
  editingJob.value = null
  form.value = { name: '', description: '', cron_expr: '', agent_id: '', prompt: '' }
  showForm.value = true
}

function openEditForm(job: CronJob) {
  editingJob.value = job
  form.value = {
    name: job.name,
    description: job.description,
    cron_expr: job.cron_expr,
    agent_id: job.agent_id,
    prompt: job.prompt,
  }
  showForm.value = true
}

async function handleSave() {
  if (!form.value.name.trim() || !form.value.cron_expr.trim()) return

  try {
    if (editingJob.value) {
      const updated = await updateCronJob(editingJob.value.id, form.value)
      const idx = jobs.value.findIndex((j) => j.id === editingJob.value!.id)
      if (idx >= 0) jobs.value[idx] = updated
    } else {
      const created = await createCronJob(form.value)
      jobs.value.push(created)
    }
    showForm.value = false
  } catch (e) {
    console.error('保存任务失败:', e)
  }
}

async function handleTrigger(job: CronJob) {
  try {
    await triggerCronJob(job.id)
    job.status = 'running'
  } catch (e) {
    console.error('触发任务失败:', e)
  }
}

async function handleToggle(job: CronJob) {
  try {
    await updateCronJob(job.id, { enabled: !job.enabled })
    job.enabled = !job.enabled
  } catch (e) {
    console.error('切换任务失败:', e)
  }
}

async function handleDelete(job: CronJob) {
  try {
    await deleteCronJob(job.id)
    jobs.value = jobs.value.filter((j) => j.id !== job.id)
  } catch (e) {
    console.error('删除任务失败:', e)
  }
}

function formatTime(ts?: string): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN')
}

function statusMap(s: string): 'online' | 'offline' | 'error' | 'running' | 'idle' {
  const map: Record<string, 'online' | 'offline' | 'error' | 'running' | 'idle'> = {
    idle: 'idle', running: 'running', error: 'error',
  }
  return map[s] || 'idle'
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('tasks.title')" :description="t('tasks.description')">
      <template #actions>
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          :style="{ background: 'var(--hc-accent)' }"
          @click="openCreateForm"
        >
          <Plus :size="16" />
          {{ t('tasks.createTask') }}
        </button>
      </template>
    </PageHeader>

    <!-- 标签页 -->
    <div class="flex items-center gap-0 px-6 pt-3 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'cron' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'cron' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'cron'"
      >
        Cron 任务 ({{ jobs.length }})
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'heartbeat' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'heartbeat' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'heartbeat'"
      >
        Heartbeat
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <!-- Cron 任务标签 -->
      <template v-else-if="activeTab === 'cron'">
        <!-- 创建/编辑表单 -->
        <div
          v-if="showForm"
          class="mb-6 max-w-lg rounded-xl border p-5 space-y-4"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
              {{ editingJob ? t('tasks.editTask') : t('tasks.createTask') }}
            </h3>
            <button
              class="p-1 rounded hover:bg-white/5"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="showForm = false"
            >
              <X :size="16" />
            </button>
          </div>
          <input
            v-model="form.name"
            type="text"
            :placeholder="t('tasks.taskName')"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
            :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
          />
          <input
            v-model="form.description"
            type="text"
            :placeholder="t('tasks.descField')"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
            :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
          />
          <input
            v-model="form.cron_expr"
            type="text"
            :placeholder="t('tasks.cronExpr')"
            class="w-full rounded-lg border px-3 py-2 text-sm font-mono outline-none"
            :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
          />
          <textarea
            v-model="form.prompt"
            rows="3"
            :placeholder="t('tasks.prompt')"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none"
            :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
          />
          <div class="flex gap-2">
            <button
              class="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-white"
              :style="{ background: 'var(--hc-accent)' }"
              @click="handleSave"
            >
              <Save :size="14" />
              {{ editingJob ? t('common.save') : t('common.create') }}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-sm"
              :style="{ color: 'var(--hc-text-secondary)' }"
              @click="showForm = false"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>

        <EmptyState
          v-if="jobs.length === 0 && !showForm"
          :icon="Clock"
          :title="t('tasks.noTasks')"
          :description="t('tasks.noTasksDesc')"
        />

        <div v-else class="space-y-3 max-w-3xl">
          <div
            v-for="job in jobs"
            :key="job.id"
            class="rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-start justify-between mb-2">
              <div>
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ job.name }}</span>
                  <StatusBadge :status="statusMap(job.status)" />
                  <span
                    v-if="!job.enabled"
                    class="text-xs px-1.5 py-0.5 rounded"
                    :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
                  >
                    {{ t('tasks.paused') }}
                  </span>
                </div>
                <p v-if="job.description" class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">
                  {{ job.description }}
                </p>
              </div>
              <div class="flex items-center gap-1">
                <button
                  class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-accent)' }"
                  :title="t('tasks.manualTrigger')"
                  @click="handleTrigger(job)"
                >
                  <Play :size="14" />
                </button>
                <button
                  class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  :title="t('common.edit')"
                  @click="openEditForm(job)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                  :style="{ color: job.enabled ? 'var(--hc-warning)' : 'var(--hc-success)' }"
                  :title="job.enabled ? '暂停' : '启用'"
                  @click="handleToggle(job)"
                >
                  <Pause v-if="job.enabled" :size="14" />
                  <Play v-else :size="14" />
                </button>
                <button
                  class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-error)' }"
                  :title="t('common.delete')"
                  @click="handleDelete(job)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <div class="flex items-center gap-4 text-xs" :style="{ color: 'var(--hc-text-muted)' }">
              <span>
                Cron: <code class="px-1 py-0.5 rounded" :style="{ background: 'var(--hc-bg-hover)' }">{{ job.cron_expr }}</code>
              </span>
              <span>Agent: {{ job.agent_name }}</span>
              <span>执行: {{ job.run_count }} 次</span>
              <span>上次: {{ formatTime(job.last_run) }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Heartbeat 标签 -->
      <template v-else>
        <div class="max-w-lg">
          <div
            class="rounded-xl border p-6"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-3 mb-4">
              <Activity :size="20" :style="{ color: 'var(--hc-success)' }" />
              <div>
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('tasks.heartbeatMonitor') }}</div>
                <StatusBadge status="online" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4 mb-4">
              <div>
                <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('tasks.checkInterval') }}</span>
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">15 分钟</div>
              </div>
              <div>
                <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('tasks.silentPeriod') }}</span>
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">22:00 — 08:00</div>
              </div>
            </div>

            <div class="space-y-2">
              <div class="text-xs font-medium mb-2" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('tasks.recentActivity') }}</div>
              <div
                v-for="(item, idx) in [
                  { time: '14:15', status: 'ok', msg: t('tasks.noNewItems') },
                  { time: '14:00', status: 'alert', msg: '发现 2 条待处理消息' },
                  { time: '13:45', status: 'ok', msg: t('tasks.noNewItems') },
                ]"
                :key="idx"
                class="flex items-center gap-2 text-xs"
              >
                <span class="tabular-nums w-10" :style="{ color: 'var(--hc-text-muted)' }">{{ item.time }}</span>
                <span :style="{ color: item.status === 'ok' ? 'var(--hc-success)' : 'var(--hc-warning)' }">
                  {{ item.status === 'ok' ? '✓' : '!' }}
                </span>
                <span :style="{ color: 'var(--hc-text-primary)' }">{{ item.msg }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
