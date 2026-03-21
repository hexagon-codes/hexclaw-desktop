<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Play, Pause, Trash2, X, Save, RefreshCw, Calendar, Hash, ChevronDown, Zap, History, CheckCircle, XCircle, Loader } from 'lucide-vue-next'
import { getCronJobs, createCronJob, deleteCronJob, pauseCronJob, resumeCronJob, triggerCronJob, getCronJobHistory, type CronJob, type CronJobInput, type CronJobRun } from '@/api/tasks'
import { useToast } from '@/composables'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()
const toast = useToast()

const jobs = ref<CronJob[]>([])
const loading = ref(true)
const showForm = ref(false)
const submitting = ref(false)

const form = ref<CronJobInput>({
  name: '',
  schedule: '',
  prompt: '',
  type: 'cron',
})

const schedulePresets = computed(() => [
  { label: t('tasks.presetDaily9'), value: '0 9 * * *' },
  { label: t('tasks.presetHourly'), value: '@every 1h' },
  { label: t('tasks.preset30min'), value: '@every 30m' },
  { label: t('tasks.preset5min'), value: '@every 5m' },
  { label: t('tasks.presetMon9'), value: '0 9 * * 1' },
  { label: t('tasks.presetNoon'), value: '0 12 * * *' },
  { label: t('tasks.presetEvening'), value: '0 18 * * *' },
  { label: t('tasks.presetDaily'), value: '@daily' },
])

const showPresets = ref(false)
const triggeringJobs = ref<Set<string>>(new Set())
const jobHistories = ref<Record<string, CronJobRun[]>>({})
const expandedJobId = ref<string | null>(null)
const expandedRunId = ref<string | null>(null)

const formValid = computed(() => {
  return form.value.name.trim() !== '' && form.value.schedule.trim() !== '' && form.value.prompt.trim() !== ''
})

async function loadJobs() {
  loading.value = true
  try {
    const res = await getCronJobs()
    jobs.value = res.jobs || []
  } catch (e) {
    console.error('加载定时任务失败:', e)
  } finally {
    loading.value = false
  }
}

onMounted(loadJobs)

function openCreateForm() {
  form.value = { name: '', schedule: '', prompt: '', type: 'cron' }
  showForm.value = true
  showPresets.value = false
}

function selectPreset(value: string) {
  form.value.schedule = value
  showPresets.value = false
}

async function handleCreate() {
  if (!formValid.value || submitting.value) return
  submitting.value = true
  try {
    await createCronJob(form.value)
    showForm.value = false
    toast.success(t('tasks.createTaskSuccess'))
    await loadJobs()
  } catch (e) {
    console.error('创建任务失败:', e)
    const msg = e instanceof Error ? e.message : String(e)
    toast.error(`${t('tasks.createTaskFailed')}: ${msg}`)
  } finally {
    submitting.value = false
  }
}

async function handlePauseResume(job: CronJob) {
  try {
    if (job.status === 'active') {
      await pauseCronJob(job.id)
      job.status = 'paused'
    } else if (job.status === 'paused') {
      await resumeCronJob(job.id)
      job.status = 'active'
    }
  } catch (e) {
    console.error('切换任务状态失败:', e)
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

async function handleTrigger(job: CronJob) {
  if (triggeringJobs.value.has(job.id)) return
  triggeringJobs.value = new Set([...triggeringJobs.value, job.id])
  try {
    await triggerCronJob(job.id)
    job.run_count += 1
    job.last_run_at = new Date().toISOString()
    // Refresh history if expanded
    if (expandedJobId.value === job.id) {
      await loadJobHistory(job.id)
    }
  } catch (e) {
    console.error('手动触发任务失败:', e)
  } finally {
    const next = new Set(triggeringJobs.value)
    next.delete(job.id)
    triggeringJobs.value = next
  }
}

async function loadJobHistory(jobId: string) {
  try {
    jobHistories.value[jobId] = await getCronJobHistory(jobId, 5)
  } catch (e) {
    console.error('加载执行历史失败:', e)
    jobHistories.value[jobId] = []
  }
}

async function toggleHistory(jobId: string) {
  if (expandedJobId.value === jobId) {
    expandedJobId.value = null
    expandedRunId.value = null
  } else {
    expandedJobId.value = jobId
    expandedRunId.value = null
    await loadJobHistory(jobId)
  }
}

function toggleRunDetail(runId: string) {
  expandedRunId.value = expandedRunId.value === runId ? null : runId
}

function formatDuration(ms?: number): string {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

function runStatusIcon(status: string) {
  switch (status) {
    case 'success': return CheckCircle
    case 'failed': return XCircle
    case 'running': return Loader
    default: return Clock
  }
}

function runStatusColor(status: string): string {
  switch (status) {
    case 'success': return 'var(--hc-success)'
    case 'failed': return 'var(--hc-error)'
    case 'running': return 'var(--hc-accent)'
    default: return 'var(--hc-text-muted)'
  }
}

function formatTime(ts?: string): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN')
}

function scheduleLabel(schedule: string): string {
  const preset = schedulePresets.value.find((p) => p.value === schedule)
  return preset ? preset.label : schedule
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'var(--hc-success)'
    case 'paused': return 'var(--hc-warning)'
    case 'done': return 'var(--hc-text-muted)'
    default: return 'var(--hc-text-muted)'
  }
}

function statusBg(status: string): string {
  switch (status) {
    case 'active': return 'rgba(50, 213, 131, 0.1)'
    case 'paused': return 'rgba(240, 180, 41, 0.1)'
    case 'done': return 'var(--hc-bg-hover)'
    default: return 'var(--hc-bg-hover)'
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'active': return t('tasks.statusActive')
    case 'paused': return t('tasks.statusPaused')
    case 'done': return t('tasks.statusDone')
    default: return status
  }
}

defineExpose({ openCreateForm, loadJobs })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <EmptyState
        v-else-if="jobs.length === 0"
        :icon="Clock"
        :title="t('tasks.noTasks')"
        :description="t('tasks.noTasksDesc')"
      />

      <div v-else class="tasks-grid">
        <div
          v-for="job in jobs"
          :key="job.id"
          class="task-card"
        >
          <!-- Card header -->
          <div class="task-card__header">
            <div class="task-card__title-row">
              <span class="task-card__name">{{ job.name }}</span>
              <span
                class="task-card__status"
                :style="{ color: statusColor(job.status), background: statusBg(job.status) }"
              >
                <span class="task-card__status-dot" :style="{ background: statusColor(job.status) }" />
                {{ statusText(job.status) }}
              </span>
            </div>
            <p class="task-card__prompt">{{ job.prompt }}</p>
          </div>

          <!-- Card meta -->
          <div class="task-card__meta">
            <div class="task-card__meta-item">
              <Calendar :size="13" />
              <span>{{ scheduleLabel(job.schedule) }}</span>
            </div>
            <div class="task-card__meta-item task-card__meta-item--next" :style="{ color: 'var(--hc-accent)', fontWeight: 500 }">
              <Clock :size="13" />
              <span>{{ t('tasks.nextRun', { time: formatTime(job.next_run_at) }) }}</span>
            </div>
            <div class="task-card__meta-item">
              <Hash :size="13" />
              <span>{{ t('tasks.execCount', { count: job.run_count }) }}</span>
            </div>
          </div>

          <!-- Card info row -->
          <div class="task-card__info">
            <span class="task-card__type-badge">
              {{ job.type === 'cron' ? t('tasks.repeat') : t('tasks.once') }}
            </span>
            <span v-if="job.last_run_at" class="task-card__last-run">
              {{ t('tasks.lastRunAt', { time: formatTime(job.last_run_at) }) }}
            </span>
          </div>

          <!-- Card actions -->
          <div class="task-card__actions">
            <button
              class="task-card__action-btn task-card__action-btn--trigger"
              :style="{ color: 'var(--hc-accent)' }"
              :title="t('tasks.triggerNow')"
              :disabled="triggeringJobs.has(job.id)"
              @click="handleTrigger(job)"
            >
              <Loader v-if="triggeringJobs.has(job.id)" :size="14" class="animate-spin" />
              <Zap v-else :size="14" />
              <span>{{ triggeringJobs.has(job.id) ? t('tasks.triggering') : t('tasks.triggerNow') }}</span>
            </button>
            <button
              v-if="job.status !== 'done'"
              class="task-card__action-btn"
              :style="{ color: job.status === 'active' ? 'var(--hc-warning)' : 'var(--hc-success)' }"
              :title="job.status === 'active' ? t('tasks.pauseTask') : t('tasks.resumeTask')"
              @click="handlePauseResume(job)"
            >
              <Pause v-if="job.status === 'active'" :size="14" />
              <Play v-else :size="14" />
              <span>{{ job.status === 'active' ? t('tasks.pauseTask') : t('tasks.resumeTask') }}</span>
            </button>
            <button
              class="task-card__action-btn"
              :style="{ color: expandedJobId === job.id ? 'var(--hc-accent)' : 'var(--hc-text-secondary)' }"
              :title="t('tasks.execHistory')"
              @click="toggleHistory(job.id)"
            >
              <History :size="14" />
              <span>{{ t('tasks.history') }}</span>
            </button>
            <button
              class="task-card__action-btn task-card__action-btn--danger"
              :title="t('common.delete')"
              @click="handleDelete(job)"
            >
              <Trash2 :size="14" />
              <span>{{ t('common.delete') }}</span>
            </button>
          </div>

          <!-- Execution history -->
          <div v-if="expandedJobId === job.id" class="task-card__history">
            <div class="task-card__history-title">{{ t('tasks.recentExecHistory') }}</div>
            <div v-if="!jobHistories[job.id]?.length" class="task-card__history-empty">{{ t('tasks.noExecHistory') }}</div>
            <div v-else class="task-card__history-list">
              <div v-for="run in jobHistories[job.id]" :key="run.id" class="task-card__history-entry">
                <div
                  class="task-card__history-item"
                  :class="{ 'task-card__history-item--clickable': !!(run.result || run.error) }"
                  @click="run.result || run.error ? toggleRunDetail(run.id) : undefined"
                >
                  <component :is="runStatusIcon(run.status)" :size="13" :style="{ color: runStatusColor(run.status), flexShrink: 0 }" />
                  <span class="task-card__history-time">{{ formatTime(run.started_at) }}</span>
                  <span v-if="run.duration_ms" class="task-card__history-duration">{{ formatDuration(run.duration_ms) }}</span>
                  <span class="task-card__history-status" :style="{ color: runStatusColor(run.status) }">{{ run.status === 'success' ? t('tasks.statusSuccess', 'SUCCESS') : t('tasks.statusFailed', 'FAILED') }}</span>
                  <ChevronDown
                    v-if="run.result || run.error"
                    :size="12"
                    class="task-card__history-chevron"
                    :class="{ 'task-card__history-chevron--open': expandedRunId === run.id }"
                    :style="{ color: 'var(--hc-text-muted)' }"
                  />
                </div>
                <div v-if="expandedRunId === run.id" class="task-card__history-detail">
                  <div v-if="run.error" class="task-card__history-error">{{ run.error }}</div>
                  <div v-if="run.result" class="task-card__history-result">{{ run.result }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Task Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showForm" class="hc-modal-overlay" @click.self="showForm = false">
          <div class="hc-modal">
            <div class="hc-modal__header">
              <h2 class="hc-modal__title">{{ t('tasks.createTask') }}</h2>
              <button class="hc-modal__close" @click="showForm = false">
                <X :size="17" />
              </button>
            </div>
            <div class="hc-modal__body">
              <!-- Task name -->
              <div class="hc-field">
                <label class="hc-field__label">{{ t('tasks.taskName') }}</label>
                <input
                  v-model="form.name"
                  type="text"
                  class="hc-input"
                  :placeholder="t('tasks.taskNamePlaceholder')"
                />
              </div>

              <!-- Schedule -->
              <div class="hc-field">
                <label class="hc-field__label">{{ t('tasks.schedule') }}</label>
                <div class="schedule-input-wrap">
                  <input
                    v-model="form.schedule"
                    type="text"
                    class="hc-input"
                    style="font-family: monospace;"
                    :placeholder="t('tasks.cronExprPlaceholder')"
                  />
                  <button
                    class="schedule-preset-btn"
                    type="button"
                    @click="showPresets = !showPresets"
                  >
                    <ChevronDown :size="14" />
                  </button>
                </div>
                <Transition name="fade">
                  <div v-if="showPresets" class="schedule-presets">
                    <button
                      v-for="preset in schedulePresets"
                      :key="preset.value"
                      class="schedule-preset-item"
                      :class="{ 'schedule-preset-item--active': form.schedule === preset.value }"
                      @click="selectPreset(preset.value)"
                    >
                      <span class="schedule-preset-item__label">{{ preset.label }}</span>
                      <code class="schedule-preset-item__value">{{ preset.value }}</code>
                    </button>
                  </div>
                </Transition>
              </div>

              <!-- Prompt -->
              <div class="hc-field">
                <label class="hc-field__label">{{ t('tasks.prompt') }}</label>
                <textarea
                  v-model="form.prompt"
                  rows="4"
                  class="hc-input"
                  style="resize: none; font-family: inherit;"
                  :placeholder="t('tasks.promptPlaceholder')"
                />
              </div>

              <!-- Type toggle -->
              <div class="hc-field">
                <label class="hc-field__label">{{ t('tasks.taskType') }}</label>
                <div class="type-toggle">
                  <button
                    class="type-toggle__btn"
                    :class="{ 'type-toggle__btn--active': form.type === 'cron' }"
                    @click="form.type = 'cron'"
                  >
                    <RefreshCw :size="14" />
                    {{ t('tasks.repeat') }}
                  </button>
                  <button
                    class="type-toggle__btn"
                    :class="{ 'type-toggle__btn--active': form.type === 'once' }"
                    @click="form.type = 'once'"
                  >
                    <Play :size="14" />
                    {{ t('tasks.once') }}
                  </button>
                </div>
              </div>
            </div>
            <div class="hc-modal__footer">
              <button class="hc-btn hc-btn-secondary" @click="showForm = false">{{ t('common.cancel') }}</button>
              <button
                class="hc-btn hc-btn-primary"
                :disabled="!formValid || submitting"
                @click="handleCreate"
              >
                <Save :size="14" />
                {{ t('common.create') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Task grid ── */
.tasks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  max-width: 1200px;
}

/* ── Task card ── */
.task-card {
  border-radius: var(--hc-radius-xl);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.task-card:hover {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 1px var(--hc-accent-subtle);
}

.task-card__header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-card__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-card__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 6px;
  border-radius: 100px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  flex-shrink: 0;
}

.task-card__status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.task-card__prompt {
  font-size: 12px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Card meta ── */
.task-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.task-card__meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--hc-text-muted);
}

/* ── Card info ── */
.task-card__info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-card__type-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 100px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}

.task-card__last-run {
  font-size: 11px;
  color: var(--hc-text-muted);
}

/* ── Card actions ── */
.task-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--hc-divider);
}

.task-card__action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--hc-radius-md);
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
  color: var(--hc-text-secondary);
}

.task-card__action-btn:hover {
  background: var(--hc-bg-hover);
}

.task-card__action-btn--danger {
  color: var(--hc-error);
}

.task-card__action-btn--danger:hover {
  background: rgba(245, 101, 101, 0.1);
}

.task-card__action-btn--trigger:hover {
  background: var(--hc-accent-subtle, rgba(99, 102, 241, 0.1));
}

.task-card__action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.animate-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── History ── */
.task-card__history {
  padding-top: 8px;
  border-top: 1px solid var(--hc-divider);
}

.task-card__history-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  margin-bottom: 6px;
}

.task-card__history-empty {
  font-size: 11px;
  color: var(--hc-text-muted);
  padding: 4px 0;
}

.task-card__history-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.task-card__history-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--hc-text-secondary);
  padding: 3px 0;
}

.task-card__history-time {
  flex: 1;
  min-width: 0;
}

.task-card__history-duration {
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
}

.task-card__history-status {
  font-weight: 500;
  font-size: 10px;
  text-transform: uppercase;
}

.task-card__history-entry {
  border-bottom: 1px solid var(--hc-border);
  padding-bottom: 4px;
}
.task-card__history-entry:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.task-card__history-item--clickable {
  cursor: pointer;
  border-radius: 4px;
  padding: 3px 4px;
  margin: 0 -4px;
}
.task-card__history-item--clickable:hover {
  background: var(--hc-bg-hover);
}

.task-card__history-chevron {
  transition: transform 0.2s;
  flex-shrink: 0;
}
.task-card__history-chevron--open {
  transform: rotate(180deg);
}

.task-card__history-detail {
  padding: 6px 8px;
  margin: 2px 0 4px 19px;
  border-radius: 6px;
  background: var(--hc-bg-hover);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

.task-card__history-error {
  color: var(--hc-danger);
}

.task-card__history-result {
  color: var(--hc-text-primary);
}

/* ── Modal ── */
.hc-modal-overlay {
  position: fixed;
  top: var(--hc-titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.hc-modal {
  width: 100%;
  max-width: 480px;
  max-height: 80vh;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: hc-scale-in 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-modal__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-modal__close {
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: background 0.15s;
}

.hc-modal__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-modal__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hc-modal__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--hc-divider);
}

.hc-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

/* ── Schedule input ── */
.schedule-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.schedule-input-wrap .hc-input {
  padding-right: 32px;
}

.schedule-preset-btn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
  display: flex;
  transition: background 0.15s, color 0.15s;
}

.schedule-preset-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.schedule-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 0 0;
}

.schedule-preset-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  transition: all 0.15s;
  font-size: 12px;
}

.schedule-preset-item:hover {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.schedule-preset-item--active {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.schedule-preset-item__label {
  color: var(--hc-text-primary);
  font-weight: 500;
}

.schedule-preset-item__value {
  color: var(--hc-text-muted);
  font-family: monospace;
  font-size: 11px;
}

/* ── Type toggle ── */
.type-toggle {
  display: flex;
  gap: 0;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  overflow: hidden;
}

.type-toggle__btn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  padding: 8px 14px;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  justify-content: center;
}

.type-toggle__btn + .type-toggle__btn {
  border-left: 1px solid var(--hc-border);
}

.type-toggle__btn--active {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}

.type-toggle__btn:hover:not(.type-toggle__btn--active) {
  background: var(--hc-bg-hover);
}

/* ── Transitions ── */
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

.fade-enter-active { transition: opacity 0.15s ease-out; }
.fade-leave-active { transition: opacity 0.1s ease-in; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
