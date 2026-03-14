<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Plus, Play, Pause, Trash2, X, Save, RefreshCw, Calendar, Hash, ChevronDown } from 'lucide-vue-next'
import { getCronJobs, createCronJob, deleteCronJob, pauseCronJob, resumeCronJob, type CronJob, type CronJobInput } from '@/api/tasks'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()

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

const schedulePresets = [
  { label: '每天早上 9 点', value: '0 9 * * *' },
  { label: '每小时', value: '@every 1h' },
  { label: '每 30 分钟', value: '@every 30m' },
  { label: '每 5 分钟', value: '@every 5m' },
  { label: '每周一早上 9 点', value: '0 9 * * 1' },
  { label: '每天中午 12 点', value: '0 12 * * *' },
  { label: '每天晚上 6 点', value: '0 18 * * *' },
  { label: '每天', value: '@daily' },
]

const showPresets = ref(false)

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
    await loadJobs()
  } catch (e) {
    console.error('创建任务失败:', e)
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

function formatTime(ts?: string): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN')
}

function scheduleLabel(schedule: string): string {
  const preset = schedulePresets.find((p) => p.value === schedule)
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
    case 'active': return '运行中'
    case 'paused': return '已暂停'
    case 'done': return '已完成'
    default: return status
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('tasks.title')" :description="t('tasks.description')">
      <template #actions>
        <button
          class="hc-btn hc-btn-secondary"
          style="padding: 6px 8px;"
          @click="loadJobs"
          title="刷新"
        >
          <RefreshCw :size="15" />
        </button>
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
            <div class="task-card__meta-item">
              <Clock :size="13" />
              <span>下次: {{ formatTime(job.next_run_at) }}</span>
            </div>
            <div class="task-card__meta-item">
              <Hash :size="13" />
              <span>已执行 {{ job.run_count }} 次</span>
            </div>
          </div>

          <!-- Card info row -->
          <div class="task-card__info">
            <span class="task-card__type-badge">
              {{ job.type === 'cron' ? '重复' : '单次' }}
            </span>
            <span v-if="job.last_run_at" class="task-card__last-run">
              上次运行: {{ formatTime(job.last_run_at) }}
            </span>
          </div>

          <!-- Card actions -->
          <div class="task-card__actions">
            <button
              v-if="job.status !== 'done'"
              class="task-card__action-btn"
              :style="{ color: job.status === 'active' ? 'var(--hc-warning)' : 'var(--hc-success)' }"
              :title="job.status === 'active' ? '暂停' : '恢复'"
              @click="handlePauseResume(job)"
            >
              <Pause v-if="job.status === 'active'" :size="14" />
              <Play v-else :size="14" />
              <span>{{ job.status === 'active' ? '暂停' : '恢复' }}</span>
            </button>
            <button
              class="task-card__action-btn task-card__action-btn--danger"
              title="删除"
              @click="handleDelete(job)"
            >
              <Trash2 :size="14" />
              <span>删除</span>
            </button>
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
                  placeholder="例如: 每日新闻摘要"
                />
              </div>

              <!-- Schedule -->
              <div class="hc-field">
                <label class="hc-field__label">执行计划</label>
                <div class="schedule-input-wrap">
                  <input
                    v-model="form.schedule"
                    type="text"
                    class="hc-input"
                    style="font-family: monospace;"
                    placeholder="Cron 表达式，如 0 9 * * *"
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
                  placeholder="描述 Agent 需要执行的任务..."
                />
              </div>

              <!-- Type toggle -->
              <div class="hc-field">
                <label class="hc-field__label">任务类型</label>
                <div class="type-toggle">
                  <button
                    class="type-toggle__btn"
                    :class="{ 'type-toggle__btn--active': form.type === 'cron' }"
                    @click="form.type = 'cron'"
                  >
                    <RefreshCw :size="14" />
                    重复
                  </button>
                  <button
                    class="type-toggle__btn"
                    :class="{ 'type-toggle__btn--active': form.type === 'once' }"
                    @click="form.type = 'once'"
                  >
                    <Play :size="14" />
                    单次
                  </button>
                </div>
              </div>
            </div>
            <div class="hc-modal__footer">
              <button class="hc-btn hc-btn-secondary" @click="showForm = false">取消</button>
              <button
                class="hc-btn hc-btn-primary"
                :disabled="!formValid || submitting"
                @click="handleCreate"
              >
                <Save :size="14" />
                创建
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

/* ── Modal ── */
.hc-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
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
