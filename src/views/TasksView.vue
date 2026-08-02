<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTime, formatElapsedSeconds, formatDurationMs } from '@/utils/time'
import { outputPreview, hasOutput } from '@/utils/output-preview'
import {
  Clock,
  Play,
  Pause,
  Trash2,
  X,
  Save,
  RefreshCw,
  Calendar,
  Hash,
  ChevronDown,
  Zap,
  History,
  CheckCircle,
  XCircle,
  Loader,
  Code,
  AlertTriangle,
  Clock3,
  Sparkles,
  ShieldAlert,
} from 'lucide-vue-next'
import {
  getCronJobs,
  createCronJob,
  deleteCronJob,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  getCronJobHistory,
  type CronJob,
  type CronJobInput,
  type CronJobRun,
  type CronCompileProgress,
  type CronCompileStage,
} from '@/api/tasks'
import { getConnectionsResult, type ConnectionSummary } from '@/api/im-channels'
import {
  preflightAutonomy,
  createAutonomyGrant,
  getAutonomySummary,
  type PreflightResult,
  type AutonomyTaskStatus,
} from '@/api/autonomy'
import type { JobSpec } from '@/types'
import { useToast } from '@/composables'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import PermissionApprovalModal from '@/components/automation/PermissionApprovalModal.vue'
import PermissionBlockedModal from '@/components/automation/PermissionBlockedModal.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()
const toast = useToast()

// 顶栏搜索词（由 AutomationView 透传）：按任务名过滤可见任务卡。
const props = withDefaults(defineProps<{ search?: string }>(), { search: '' })

const jobs = ref<CronJob[]>([])
const filteredJobs = computed(() => {
  const q = props.search.trim().toLowerCase()
  if (!q) return jobs.value
  return jobs.value.filter((j) => (j.name ?? '').toLowerCase().includes(q))
})
const loading = ref(true)
const showForm = ref(false)
const submitting = ref(false)

const form = ref<CronJobInput>({
  name: '',
  schedule: '',
  prompt: '',
  type: 'cron',
  chat_id: '',
  continuous: false,
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

// ── 投递目标（§5 一处存处处引）─────────────────────────────────
// 通用渠道类型（始终可选）+ 已配置连接实例（从连接库下拉，按稳定 id 引用）。
// 留空 = 后端按 prompt 由 LLM 推导（默认 chat）；选了即覆盖。
const GENERIC_DELIVER_CHANNELS = ['chat', 'push', 'feishu', 'discord', 'wechat'] as const
const connections = ref<ConnectionSummary[]>([])
// 连接库拉取故障提示（区分「未配置」与「sidecar/权限/网络故障」，BUG-20260718）。
const connectionsError = ref<string | null>(null)

/**
 * 可投递的已配置连接：启用 + **具备发送能力**。
 * 后端 capabilities 派生自 provider：email 只收（['receive']），IM 可发（含 'send'）。
 * 必须按 capabilities 闸门，否则只收的 email 被选作投递目标 → 运行期 instanceMgr.Send "no running adapter" 必失败。
 */
const deliverableConnections = computed(() =>
  connections.value.filter(
    (c) => c.enabled !== false && (c.capabilities?.includes('send') ?? false),
  ),
)

function isDeliverSelected(target: string): boolean {
  return (form.value.deliver ?? []).includes(target)
}

function toggleDeliver(target: string) {
  const list = form.value.deliver ? [...form.value.deliver] : []
  const idx = list.indexOf(target)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(target)
  form.value.deliver = list
}

async function loadConnections() {
  // BUG-20260718（§15）：用 getConnectionsResult 区分「未配置」与「故障」——
  // 后端故障时显示告警而非把它画成「没有连接」（旧 getConnections 会吞成空列表）。
  const r = await getConnectionsResult()
  connections.value = r.connections
  connectionsError.value = r.error ?? null
}

const triggeringJobs = ref<Set<string>>(new Set())
const pausingJobs = ref<Set<string>>(new Set())
const deletingJobs = ref<Set<string>>(new Set())
const pendingDeleteJob = ref<CronJob | null>(null)
const jobHistories = ref<Record<string, CronJobRun[]>>({})
const expandedJobId = ref<string | null>(null)
const expandedRunId = ref<string | null>(null)
const scriptVisible = ref<Set<string>>(new Set())
const expandedStdout = ref<Set<string>>(new Set())
const expandedStderr = ref<Set<string>>(new Set())

function toggleScript(jobId: string) {
  const next = new Set(scriptVisible.value)
  if (next.has(jobId)) next.delete(jobId)
  else next.add(jobId)
  scriptVisible.value = next
}

function toggleStdout(runId: string) {
  const next = new Set(expandedStdout.value)
  const key = runId
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedStdout.value = next
}

function toggleStderr(runId: string) {
  const next = new Set(expandedStderr.value)
  const key = runId
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedStderr.value = next
}

/**
 * IM/连接投递目标需要 chat_id：deliver 含任何非 chat/push 目标时，后端 Deliverer
 * （cmd/hexclaw/main.go:1341）要求 job.ChatID 非空，否则硬失败。chat/push 走 notifier 不需要。
 */
const needsChatId = computed(() =>
  (form.value.deliver ?? []).some((t) => t !== 'chat' && t !== 'push'),
)

const formValid = computed(() => {
  const base =
    form.value.name.trim() !== '' &&
    form.value.schedule.trim() !== '' &&
    form.value.prompt.trim() !== ''
  // 选了 IM/连接投递目标却没填 chat_id → 必然投递失败，阻止提交。
  return base && (!needsChatId.value || (form.value.chat_id ?? '').trim() !== '')
})

/** Agent-runtime jobs reason per run: no compiled script to display. */
function isAgentJob(job: CronJob): boolean {
  return job.spec?.runtime === 'agent'
}

/**
 * Backend uses the Go zero time ("0001-01-01T00:00:00Z") for never-compiled
 * specs (agent jobs). Treat anything before year 2000 as "not compiled".
 */
function hasRealCompiledAt(spec: JobSpec | null): boolean {
  if (!spec?.compiled?.at) return false
  const d = new Date(spec.compiled.at)
  return !isNaN(d.getTime()) && d.getFullYear() >= 2000
}

async function loadJobs() {
  loading.value = true
  try {
    const res = await getCronJobs()
    jobs.value = res.jobs || []
    // 权限状态刷新不阻塞任务列表（后端未开启治理时静默降级）。
    void loadPermissionStatuses()
  } catch (e) {
    console.error('加载定时任务失败:', e)
    toast.error(t('tasks.loadJobsFailed', '加载定时任务失败'))
  } finally {
    loading.value = false
  }
}

// ── 自动化权限：静默预检（条件式向导）+ 任务卡阻断徽章 ─────────────
// 全绿 → 一步创建即启用，不出现任何权限步骤；命中需审批能力才展开审批弹窗。
const approvalOpen = ref(false)
const approvalPreflight = ref<PreflightResult | null>(null)
const approvalBusy = ref(false)
// task_ref(去前缀 job.id) → 权限状态；!all_clear 的任务卡显示「待授权 · 去开启」。
const permissionStatuses = ref<Map<string, AutonomyTaskStatus>>(new Map())
const blockedOpen = ref(false)
const blockedTask = ref<AutonomyTaskStatus | null>(null)

async function loadPermissionStatuses() {
  try {
    const res = await getAutonomySummary()
    const map = new Map<string, AutonomyTaskStatus>()
    for (const status of res?.tasks ?? []) {
      if (status.kind === 'cron') map.set(status.task_ref.replace(/^cron:/, ''), status)
    }
    permissionStatuses.value = map
  } catch {
    // 老后端/治理未启用：无徽章即可，不打扰
    permissionStatuses.value = new Map()
  }
}

function permissionPending(job: CronJob): AutonomyTaskStatus | undefined {
  const status = permissionStatuses.value.get(job.id)
  return status && !status.all_clear ? status : undefined
}

function openBlockedModal(job: CronJob) {
  blockedTask.value = permissionStatuses.value.get(job.id) ?? null
  blockedOpen.value = true
}

async function onBlockedResolved() {
  blockedOpen.value = false
  await loadJobs()
}

onMounted(loadJobs)

// Click outside any task card collapses the expanded history (and its
// nested expansions) — the panel otherwise stayed open indefinitely.
// Exemptions: the create/edit form modal (teleported to body) and the page
// toolbar/header actions — interacting with those must not silently close
// the history the user is looking at. Clicking truly outside still collapses.
const OUTSIDE_CLICK_EXEMPT_SELECTOR = '.task-card, .hc-modal-overlay, .hc-toolbar'
function collapseOnOutsideClick(event: MouseEvent) {
  if (!expandedJobId.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest(OUTSIDE_CLICK_EXEMPT_SELECTOR)) return
  // Collapsing hides the history panel, so its 3s poll has nothing to update —
  // stop every watch instead of leaking intervals against now-hidden jobs.
  stopAllRunWatches()
  expandedJobId.value = null
  expandedRunId.value = null
  expandedStdout.value = new Set()
  expandedStderr.value = new Set()
}
onMounted(() => document.addEventListener('click', collapseOnOutsideClick))
onUnmounted(() => document.removeEventListener('click', collapseOnOutsideClick))

function openCreateForm() {
  form.value = {
    name: '',
    schedule: '',
    prompt: '',
    type: 'cron',
    deliver: [],
    chat_id: '',
    continuous: false,
  }
  loadConnections() // 打开即拉取连接库（已缓存则瞬时返回；失败优雅降级）
  showForm.value = true
  showPresets.value = false
}

function selectPreset(value: string) {
  form.value.schedule = value
  showPresets.value = false
}

// 创建任务进度状态（v2 SSE 流式编译）
const createProgress = ref<CronCompileProgress | null>(null)
const createAbort = ref<AbortController | null>(null)

function stageLabel(stage: CronCompileStage): string {
  switch (stage) {
    case 'analyzing':
      return t('tasks.stageAnalyzing', '解析需求…')
    case 'calling_llm':
      return t('tasks.stageCallingLLM', '调用 LLM 生成脚本…')
    case 'validating':
      return t('tasks.stageValidating', '校验脚本安全性…')
    case 'persisting':
      return t('tasks.stagePersisting', '保存任务…')
    default:
      return stage
  }
}

function stageProgress(stage: CronCompileStage): number {
  switch (stage) {
    case 'analyzing':
      return 10
    case 'calling_llm':
      return 60
    case 'validating':
      return 85
    case 'persisting':
      return 95
    default:
      return 5
  }
}

async function handleCreate() {
  if (!formValid.value || submitting.value) return
  // 静默预检（条件式向导）：全绿一步创建；命中需审批能力才展开审批步骤。
  // 预检不可用（老后端/离线）按全绿放行——运行时权限闸仍兜底，不会静默越权。
  let pf: PreflightResult | null = null
  try {
    pf = await preflightAutonomy({
      source: 'cron',
      prompt: form.value.prompt,
      deliver: !!(form.value.deliver && form.value.deliver.length),
    })
  } catch {
    pf = null
  }
  if (pf && !pf.all_clear) {
    approvalPreflight.value = pf
    approvalOpen.value = true
    return
  }
  await submitCreate()
}

/** 实际提交创建；返回创建成功的 job（授权流程需要 task_ref），失败返回 null。 */
async function submitCreate(options: { paused?: boolean } = {}): Promise<CronJob | null> {
  if (submitting.value) return null
  submitting.value = true
  createProgress.value = null
  const ctrl = new AbortController()
  createAbort.value = ctrl
  try {
    const result = await createCronJob(
      { ...form.value, ...(options.paused ? { paused: true } : {}) },
      {
        signal: ctrl.signal,
        onProgress: (p) => {
          createProgress.value = p
        },
      },
    )
    showForm.value = false
    toast.success(t('tasks.createTaskSuccess'))
    await loadJobs()
    return result?.job ?? null
  } catch (e) {
    if (ctrl.signal.aborted) {
      toast.info(t('tasks.createTaskCanceled', '已取消创建'))
    } else {
      console.error('创建任务失败:', e)
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`${t('tasks.createTaskFailed')}: ${msg}`)
    }
    return null
  } finally {
    submitting.value = false
    createProgress.value = null
    createAbort.value = null
  }
}

/** 审批三选一（从窄到宽）：任务级授权（推荐）/ 先创建不授权 / 保存为暂停。 */
async function onApprovalChoose(mode: 'grant' | 'later' | 'paused') {
  if (approvalBusy.value) return
  approvalBusy.value = true
  const needs = approvalPreflight.value?.needs_decision ?? []
  try {
    if (mode === 'later') {
      approvalOpen.value = false
      await submitCreate()
      return
    }
    if (mode === 'paused') {
      approvalOpen.value = false
      await submitCreate({ paused: true })
      return
    }
    // grant：暂停态创建冻结任务意图 → 写任务级授权 → resume 启用。
    const job = await submitCreate({ paused: true })
    if (job) {
      // FS-6：授权与启用分两段，文案按真实落点区分——grant 已幂等落库后 resume
      // 失败不应报「授权未完成」（会误导用户重复授权）。重试 grant 也安全（后端幂等）。
      let granted = false
      try {
        await createAutonomyGrant({
          task_ref: `cron:${job.id}`,
          source: 'cron',
          entries: needs,
          note: t('autonomy.approval.grantNote', '创建流任务级授权'),
        })
        granted = true
        await resumeCronJob(job.id)
        toast.success(t('autonomy.approval.grantedAndEnabled', '已授权并启用'))
      } catch (e) {
        console.error('任务级授权/启用失败:', e)
        if (granted) {
          // 授权已落库，仅启用失败：任务保持暂停，提示在任务卡上直接启用（无需重新授权）。
          toast.error(
            t('autonomy.approval.enableFailed', '授权已保存，但启用未成功，可在任务卡上直接启用'),
          )
        } else {
          toast.error(
            t('autonomy.approval.grantFailed', '授权未完成，任务已保存为暂停，可在任务卡上重试'),
          )
        }
      }
      await loadJobs()
    }
    approvalOpen.value = false
  } finally {
    approvalBusy.value = false
  }
}

function cancelCreate() {
  createAbort.value?.abort()
}

async function handlePauseResume(job: CronJob) {
  if (pausingJobs.value.has(job.id)) return
  pausingJobs.value = new Set([...pausingJobs.value, job.id])
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
    toast.error(t('tasks.toggleStatusFailed', '切换任务状态失败'))
  } finally {
    const next = new Set(pausingJobs.value)
    next.delete(job.id)
    pausingJobs.value = next
  }
}

async function confirmDeleteJob() {
  const job = pendingDeleteJob.value
  if (!job) return
  if (deletingJobs.value.has(job.id)) return
  pendingDeleteJob.value = null
  deletingJobs.value = new Set([...deletingJobs.value, job.id])
  try {
    await deleteCronJob(job.id)
    jobs.value = jobs.value.filter((j) => j.id !== job.id)
    stopRunWatch(job.id)
    delete jobHistories.value[job.id]
    if (expandedJobId.value === job.id) {
      expandedJobId.value = null
      expandedRunId.value = null
    }
  } catch (e) {
    console.error('删除任务失败:', e)
    toast.error(t('tasks.deleteTaskFailed', '删除任务失败'))
  } finally {
    const next = new Set(deletingJobs.value)
    next.delete(job.id)
    deletingJobs.value = next
  }
}

async function handleTrigger(job: CronJob) {
  if (triggeringJobs.value.has(job.id)) return
  triggeringJobs.value = new Set([...triggeringJobs.value, job.id])
  try {
    await triggerCronJob(job.id)
    job.run_count += 1
    job.last_run_at = new Date().toISOString()
    toast.success(t('tasks.triggerSuccess', '任务已触发，见历史'))
    // Run executes async on the backend (agent runs can take minutes):
    // show an optimistic running row and poll until a terminal row appears.
    startRunWatch(job.id)
  } catch (e) {
    console.error('手动触发任务失败:', e)
    toast.error(t('tasks.triggerFailed', '触发失败'))
  } finally {
    const next = new Set(triggeringJobs.value)
    next.delete(job.id)
    triggeringJobs.value = next
  }
}

// ── Run watch: optimistic running row + history polling (Issue: stale history
//    after manual trigger) ────────────────────────────────────────────────
const RUN_WATCH_POLL_MS = 3000
const RUN_WATCH_TIMEOUT_MS = 8 * 60 * 1000
/** Statuses that mean the run finished — stop polling when one shows up. */
const TERMINAL_RUN_STATUSES = new Set([
  'success',
  'failed',
  'error',
  'timeout',
  'healed',
  'heal_failed',
])
/**
 * Forward-only match tolerance (ms). A row counts as "this trigger's row" only
 * if it started at/after the local trigger time, minus a tiny clock-skew
 * allowance. Kept small on purpose: a wide window let a scheduled run that
 * fired seconds *before* the click be mistaken for the manual run — if that
 * older row was already terminal, the watch stopped and the optimistic running
 * row vanished before the real manual run appeared.
 */
const RUN_MATCH_SLACK_MS = 3_000

const runWatches = new Map<string, { triggeredAt: number; timer: ReturnType<typeof setInterval> }>()
/** Reactive clock driving the live elapsed label of running rows. */
const nowMs = ref(Date.now())
let elapsedTicker: ReturnType<typeof setInterval> | null = null

function optimisticRunId(jobId: string): string {
  return `optimistic-${jobId}`
}

function makeOptimisticRun(jobId: string, triggeredAt: number): CronJobRun {
  return {
    id: optimisticRunId(jobId),
    job_id: jobId,
    status: 'running',
    started_at: new Date(triggeredAt).toISOString(),
  }
}

/**
 * Merge fetched history with the in-flight watch: keep the optimistic row on
 * top until the server reports a row for this trigger, and tell the caller
 * whether that row is terminal (so polling can stop).
 */
function mergeHistoryWithWatch(
  jobId: string,
  runs: CronJobRun[],
): { runs: CronJobRun[]; terminal: boolean } {
  const watch = runWatches.get(jobId)
  if (!watch) return { runs, terminal: false }
  const fresh = runs.find((r) => {
    const startedAt = new Date(r.started_at).getTime()
    return !isNaN(startedAt) && startedAt >= watch.triggeredAt - RUN_MATCH_SLACK_MS
  })
  if (fresh) {
    // Real row arrived — it replaces the optimistic placeholder.
    return { runs, terminal: TERMINAL_RUN_STATUSES.has(fresh.status) }
  }
  return { runs: [makeOptimisticRun(jobId, watch.triggeredAt), ...runs], terminal: false }
}

function startRunWatch(jobId: string) {
  stopRunWatch(jobId)
  const triggeredAt = Date.now()
  // Auto-expand this job's history so the new run is visible immediately.
  expandedJobId.value = jobId
  expandedRunId.value = null
  const existing = (jobHistories.value[jobId] ?? []).filter((r) => r.id !== optimisticRunId(jobId))
  jobHistories.value[jobId] = [makeOptimisticRun(jobId, triggeredAt), ...existing]

  if (!elapsedTicker) {
    elapsedTicker = setInterval(() => {
      nowMs.value = Date.now()
    }, 1000)
  }
  const timer = setInterval(() => {
    if (Date.now() - triggeredAt >= RUN_WATCH_TIMEOUT_MS) {
      // Give up after 8 minutes: drop the optimistic row via a final reload.
      stopRunWatch(jobId)
      void loadJobHistory(jobId)
      return
    }
    void loadJobHistory(jobId)
  }, RUN_WATCH_POLL_MS)
  runWatches.set(jobId, { triggeredAt, timer })
}

function stopRunWatch(jobId: string) {
  const watch = runWatches.get(jobId)
  if (!watch) return
  clearInterval(watch.timer)
  runWatches.delete(jobId)
  if (runWatches.size === 0 && elapsedTicker) {
    clearInterval(elapsedTicker)
    elapsedTicker = null
  }
}

function stopAllRunWatches() {
  const jobIds = Array.from(runWatches.keys())
  for (const jobId of jobIds) stopRunWatch(jobId)
}
onUnmounted(stopAllRunWatches)

/** Live elapsed label for a running row ("42s", then "2:06" past a minute). */
function runningElapsed(run: CronJobRun): string {
  const startedAt = new Date(run.started_at).getTime()
  if (isNaN(startedAt)) return ''
  return formatElapsedSeconds((nowMs.value - startedAt) / 1000)
}

const historyLoading = new Set<string>()

async function loadJobHistory(jobId: string) {
  if (historyLoading.has(jobId)) return
  historyLoading.add(jobId)
  try {
    const runs = await getCronJobHistory(jobId, 5)
    const { runs: merged, terminal } = mergeHistoryWithWatch(jobId, runs)
    jobHistories.value[jobId] = merged
    // Refresh the clock so running rows fetched outside a watch (scheduled
    // runs) still show a sensible elapsed value.
    nowMs.value = Date.now()
    if (terminal) stopRunWatch(jobId)
  } catch (e) {
    console.error('加载执行历史失败:', e)
    if (!jobHistories.value[jobId]) jobHistories.value[jobId] = []
  } finally {
    historyLoading.delete(jobId)
  }
}

async function toggleHistory(jobId: string) {
  if (expandedJobId.value === jobId) {
    // Manual collapse hides this job's history — stop its poll so it does not
    // keep hitting the backend (and mutating jobHistories) for up to 8 minutes.
    stopRunWatch(jobId)
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

function runStatusIcon(status: string) {
  switch (status) {
    case 'success':
      return CheckCircle
    case 'failed':
    case 'error':
      return XCircle
    case 'timeout':
      return Clock3
    case 'running':
      return Loader
    case 'healed':
      return CheckCircle
    case 'heal_failed':
      return XCircle
    default:
      return Clock
  }
}

function runStatusColor(status: string): string {
  switch (status) {
    case 'success':
      return 'var(--hc-success)'
    case 'failed':
    case 'error':
      return 'var(--hc-error)'
    case 'timeout':
      return 'var(--hc-warning)'
    case 'running':
      return 'var(--hc-accent)'
    case 'healed':
      return 'var(--hc-accent)'
    case 'heal_failed':
      return 'var(--hc-warning)'
    default:
      return 'var(--hc-text-muted)'
  }
}

function runStatusText(status: string): string {
  switch (status) {
    case 'success':
      return t('tasks.statusSuccess', '成功')
    case 'failed':
    case 'error':
      return t('tasks.statusFailed', '失败')
    case 'timeout':
      return t('tasks.statusTimeout', '超时')
    case 'running':
      return t('tasks.statusRunning', '运行中')
    case 'healed':
      return t('tasks.statusHealed', '已自愈')
    case 'heal_failed':
      return t('tasks.statusHealFailed', '自愈失败')
    default:
      return status
  }
}

// formatTime imported from @/utils/time

function scheduleLabel(schedule: string): string {
  const preset = schedulePresets.value.find((p) => p.value === schedule)
  return preset ? preset.label : schedule
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'var(--hc-success)'
    case 'paused':
      return 'var(--hc-warning)'
    case 'done':
      return 'var(--hc-text-muted)'
    default:
      return 'var(--hc-text-muted)'
  }
}

function statusBg(status: string): string {
  switch (status) {
    case 'active':
      return 'rgba(50, 213, 131, 0.1)'
    case 'paused':
      return 'rgba(240, 180, 41, 0.1)'
    case 'done':
      return 'var(--hc-bg-hover)'
    default:
      return 'var(--hc-bg-hover)'
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'active':
      return t('tasks.statusActive')
    case 'paused':
      return t('tasks.statusPaused')
    case 'done':
      return t('tasks.statusDone')
    default:
      return status
  }
}

defineExpose({ openCreateForm, loadJobs })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <EmptyState
        v-else-if="filteredJobs.length === 0"
        :icon="Clock"
        :title="t('tasks.noTasks')"
        :description="t('tasks.noTasksDesc')"
      />

      <div v-else class="tasks-grid">
        <div v-for="job in filteredJobs" :key="job.id" class="task-card">
          <!-- Card header -->
          <div class="task-card__header">
            <div class="task-card__title-row">
              <span class="task-card__name">{{ job.name }}</span>
              <span
                class="task-card__status"
                :style="{ color: statusColor(job.status), background: statusBg(job.status) }"
              >
                <span
                  class="task-card__status-dot"
                  :style="{ background: statusColor(job.status) }"
                />
                {{ statusText(job.status) }}
              </span>
              <button
                v-if="permissionPending(job)"
                class="task-card__perm-badge"
                data-testid="perm-badge"
                :title="t('autonomy.badge.openTitle', '权限待授权，点击处理')"
                @click.stop="openBlockedModal(job)"
              >
                <ShieldAlert :size="12" />
                {{ t('autonomy.badge.pending', '待授权') }} ·
                {{ t('autonomy.badge.open', '去开启') }}
              </button>
            </div>
            <p class="task-card__prompt">{{ job.source_prompt }}</p>
          </div>

          <!-- Card meta -->
          <div class="task-card__meta">
            <div class="task-card__meta-item">
              <Calendar :size="13" />
              <span>{{ scheduleLabel(job.schedule) }}</span>
            </div>
            <div
              class="task-card__meta-item task-card__meta-item--next"
              :style="{ color: 'var(--hc-accent)', fontWeight: 500 }"
            >
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
              <span>{{
                triggeringJobs.has(job.id) ? t('tasks.triggering') : t('tasks.triggerNow')
              }}</span>
            </button>
            <button
              v-if="job.status !== 'done'"
              class="task-card__action-btn"
              :style="{
                color: job.status === 'active' ? 'var(--hc-warning)' : 'var(--hc-success)',
              }"
              :title="job.status === 'active' ? t('tasks.pauseTask') : t('tasks.resumeTask')"
              :disabled="pausingJobs.has(job.id)"
              @click="handlePauseResume(job)"
            >
              <Loader v-if="pausingJobs.has(job.id)" :size="14" class="animate-spin" />
              <Pause v-else-if="job.status === 'active'" :size="14" />
              <Play v-else :size="14" />
              <span>
                {{
                  pausingJobs.has(job.id)
                    ? t('common.loading', '处理中...')
                    : job.status === 'active'
                      ? t('tasks.pauseTask')
                      : t('tasks.resumeTask')
                }}
              </span>
            </button>
            <button
              class="task-card__action-btn"
              :style="{
                color: expandedJobId === job.id ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
              }"
              :title="t('tasks.execHistory')"
              @click="toggleHistory(job.id)"
            >
              <History :size="14" />
              <span>{{
                expandedJobId === job.id ? t('tasks.hideHistory', '收起历史') : t('tasks.history')
              }}</span>
            </button>
            <button
              v-if="job.spec && !isAgentJob(job)"
              class="task-card__action-btn"
              :style="{
                color: scriptVisible.has(job.id) ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
              }"
              :title="t('tasks.viewScript', '查看脚本')"
              @click="toggleScript(job.id)"
            >
              <Code :size="14" />
              <span>{{
                scriptVisible.has(job.id)
                  ? t('tasks.hideScript', '隐藏脚本')
                  : t('tasks.viewScript', '查看脚本')
              }}</span>
            </button>
            <button
              class="task-card__action-btn task-card__action-btn--danger"
              :title="t('common.delete')"
              :disabled="deletingJobs.has(job.id)"
              @click="pendingDeleteJob = job"
            >
              <Loader v-if="deletingJobs.has(job.id)" :size="14" class="animate-spin" />
              <Trash2 v-else :size="14" />
              <span>{{
                deletingJobs.has(job.id) ? t('common.loading', '处理中...') : t('common.delete')
              }}</span>
            </button>
          </div>

          <!-- Agent runtime badge: agent jobs reason per run, no script panel -->
          <div v-if="isAgentJob(job)" class="task-card__agent-badge">
            <Sparkles :size="12" />
            <span
              >{{ t('tasks.agentRuntime', 'Agent · 每次执行由 AI 推理完成')
              }}<template v-if="job.spec?.timeout_s"> · {{ job.spec.timeout_s }}s</template></span
            >
          </div>

          <!-- Compiled script viewer (script jobs only) -->
          <div
            v-if="scriptVisible.has(job.id) && job.spec && !isAgentJob(job)"
            class="task-card__script"
          >
            <div class="task-card__script-header">
              <span class="task-card__script-meta">
                Python · {{ job.spec.deps?.length || 0 }} deps · {{ job.spec.timeout_s }}s
              </span>
              <span
                v-if="hasRealCompiledAt(job.spec)"
                class="task-card__script-meta task-card__script-meta--dim"
              >
                {{ t('tasks.compiledBy', '编译于') }} {{ formatTime(job.spec.compiled.at) }} ·
                {{ job.spec.compiled.model }}
              </span>
            </div>
            <pre class="task-card__script-code">{{ job.spec.script }}</pre>
            <div v-if="job.spec.deps?.length" class="task-card__script-deps">
              deps: {{ job.spec.deps.join(', ') }}
            </div>
          </div>

          <!-- Execution history -->
          <div v-if="expandedJobId === job.id" class="task-card__history">
            <div class="task-card__history-title">{{ t('tasks.recentExecHistory') }}</div>
            <div v-if="!jobHistories[job.id]?.length" class="task-card__history-empty">
              {{ t('tasks.noExecHistory') }}
            </div>
            <div v-else class="task-card__history-list">
              <div
                v-for="run in jobHistories[job.id]"
                :key="run.id"
                class="task-card__history-entry"
              >
                <div
                  class="task-card__history-item"
                  :class="{
                    'task-card__history-item--clickable': !!(
                      run.result ||
                      run.error ||
                      hasOutput(run.stdout) ||
                      hasOutput(run.stderr)
                    ),
                  }"
                  @click="
                    run.result || run.error || hasOutput(run.stdout) || hasOutput(run.stderr)
                      ? toggleRunDetail(run.id)
                      : undefined
                  "
                >
                  <component
                    :is="runStatusIcon(run.status)"
                    :size="13"
                    :style="{ color: runStatusColor(run.status), flexShrink: 0 }"
                  />
                  <span class="task-card__history-time">{{ formatTime(run.started_at) }}</span>
                  <span v-if="run.status === 'running'" class="task-card__history-duration">{{
                    runningElapsed(run)
                  }}</span>
                  <span v-else-if="run.duration_ms" class="task-card__history-duration">{{
                    formatDurationMs(run.duration_ms)
                  }}</span>
                  <span
                    class="task-card__history-status"
                    :style="{ color: runStatusColor(run.status) }"
                    >{{ runStatusText(run.status) }}</span
                  >
                  <span
                    v-if="typeof run.exit_code === 'number' && run.exit_code !== 0"
                    class="task-card__history-exit"
                  >
                    exit {{ run.exit_code }}
                  </span>
                  <ChevronDown
                    v-if="run.result || run.error || hasOutput(run.stdout) || hasOutput(run.stderr)"
                    :size="12"
                    class="task-card__history-chevron"
                    :class="{ 'task-card__history-chevron--open': expandedRunId === run.id }"
                    :style="{ color: 'var(--hc-text-muted)' }"
                  />
                </div>
                <div v-if="expandedRunId === run.id" class="task-card__history-detail">
                  <div v-if="run.error" class="task-card__history-error">
                    <AlertTriangle :size="12" /> {{ run.error }}
                  </div>
                  <div
                    v-if="run.data !== undefined && run.data !== null"
                    class="task-card__history-data"
                  >
                    <strong>data:</strong>
                    <pre>{{
                      typeof run.data === 'string' ? run.data : JSON.stringify(run.data, null, 2)
                    }}</pre>
                  </div>
                  <div v-if="hasOutput(run.stdout)" class="task-card__history-stdout">
                    <button class="task-card__history-toggle" @click.stop="toggleStdout(run.id)">
                      {{ t('tasks.runOutput') }} {{ expandedStdout.has(run.id) ? '▾' : '▸' }}
                    </button>
                    <span v-if="!expandedStdout.has(run.id)" class="task-card__history-preview">{{
                      outputPreview(run.stdout)
                    }}</span>
                    <pre v-if="expandedStdout.has(run.id)">{{ run.stdout }}</pre>
                  </div>
                  <div v-if="hasOutput(run.stderr)" class="task-card__history-stderr">
                    <button class="task-card__history-toggle" @click.stop="toggleStderr(run.id)">
                      {{ t('tasks.runErrorOutput') }} {{ expandedStderr.has(run.id) ? '▾' : '▸' }}
                    </button>
                    <span v-if="!expandedStderr.has(run.id)" class="task-card__history-preview">{{
                      outputPreview(run.stderr)
                    }}</span>
                    <pre v-if="expandedStderr.has(run.id)">{{ run.stderr }}</pre>
                  </div>
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
                <HcClearableField>
                  <input
                    v-model="form.name"
                    type="text"
                    class="hc-input"
                    :placeholder="t('tasks.taskNamePlaceholder')"
                  />
                </HcClearableField>
              </div>

              <!-- Schedule -->
              <div class="hc-field">
                <label class="hc-field__label">{{ t('tasks.schedule') }}</label>
                <div class="schedule-input-wrap">
                  <HcClearableField>
                    <input
                      v-model="form.schedule"
                      type="text"
                      class="hc-input"
                      style="font-family: monospace"
                      :placeholder="t('tasks.cronExprPlaceholder')"
                    />
                  </HcClearableField>
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
                <HcClearableField>
                  <textarea
                    v-model="form.prompt"
                    rows="4"
                    class="hc-input"
                    style="resize: none; font-family: inherit"
                    :placeholder="t('tasks.promptPlaceholder')"
                  />
                </HcClearableField>
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

              <!-- 投递目标（§5 一处存处处引）：通用渠道类型 + 从连接库选已配置实例 -->
              <div class="hc-field">
                <label class="hc-field__label">{{ t('tasks.deliverTo', '通知到') }}</label>
                <div class="deliver-chips">
                  <button
                    v-for="ch in GENERIC_DELIVER_CHANNELS"
                    :key="ch"
                    type="button"
                    class="deliver-chip"
                    :class="{ 'deliver-chip--on': isDeliverSelected(ch) }"
                    @click="toggleDeliver(ch)"
                  >
                    {{ t(`tasks.deliverChannel.${ch}`) }}
                  </button>
                </div>
                <p v-if="connectionsError" class="deliver-hint deliver-hint--error">
                  <AlertTriangle :size="13" />
                  {{ t('tasks.connectionsLoadFailed', '连接库加载失败（并非没有连接）：')
                  }}{{ connectionsError }}
                </p>
                <template v-if="deliverableConnections.length">
                  <div class="deliver-sublabel">
                    {{ t('tasks.deliverFromConnections', '或从连接库选择') }}
                  </div>
                  <div class="deliver-chips">
                    <button
                      v-for="conn in deliverableConnections"
                      :key="conn.id"
                      type="button"
                      class="deliver-chip deliver-chip--connection"
                      :class="{ 'deliver-chip--on': isDeliverSelected(conn.id) }"
                      @click="toggleDeliver(conn.id)"
                    >
                      {{ conn.name || conn.provider }}
                      <span class="deliver-chip__provider">{{ conn.provider }}</span>
                    </button>
                  </div>
                </template>
                <p class="deliver-hint">
                  {{ t('tasks.deliverHint', '留空 = 自动（默认发到当前会话）') }}
                </p>
                <!-- IM/连接投递目标需指定会话/群组 ID（后端 Deliverer 必需，否则投递失败） -->
                <div v-if="needsChatId" class="hc-field" style="margin-top: 10px">
                  <label class="hc-field__label">{{
                    t('tasks.chatIdLabel', '会话/群组 ID')
                  }}</label>
                  <HcClearableField>
                    <input
                      v-model="form.chat_id"
                      class="hc-input"
                      :placeholder="t('tasks.chatIdPlaceholder', '如飞书 chat_id / 群 ID')"
                    />
                  </HcClearableField>
                  <p class="deliver-hint">
                    {{ t('tasks.chatIdHint', 'IM/连接投递必填——指定要发送到的会话或群组') }}
                  </p>
                </div>
              </div>

              <!-- 持续型任务：长目标分多次累积推进 + 跨 tick 检查点 -->
              <div class="hc-field">
                <label class="continuous-toggle">
                  <input v-model="form.continuous" type="checkbox" class="continuous-toggle__cb" />
                  <span class="continuous-toggle__text">
                    {{ t('tasks.continuousLabel', '持续型任务') }}
                  </span>
                </label>
                <p class="deliver-hint">
                  {{
                    t(
                      'tasks.continuousHint',
                      '分多次累积推进长目标——每次只做下一个增量，带进度存档（重启可续），目标完成 / 卡住自动收工。',
                    )
                  }}
                </p>
              </div>
            </div>
            <!-- 编译进度（SSE 流式） -->
            <div v-if="submitting && createProgress" class="hc-compile-progress">
              <div class="hc-compile-progress__header">
                <Loader :size="14" class="animate-spin" />
                <span>{{ stageLabel(createProgress.stage) }}</span>
                <span class="hc-compile-progress__pct"
                  >{{ stageProgress(createProgress.stage) }}%</span
                >
              </div>
              <div class="hc-compile-progress__bar">
                <div
                  class="hc-compile-progress__fill"
                  :style="{ width: stageProgress(createProgress.stage) + '%' }"
                ></div>
              </div>
              <div v-if="createProgress.message" class="hc-compile-progress__msg">
                {{ createProgress.message }}
              </div>
            </div>
            <div class="hc-modal__footer">
              <button
                class="hc-btn hc-btn-secondary"
                @click="submitting ? cancelCreate() : (showForm = false)"
              >
                {{ submitting ? t('common.cancel') : t('common.cancel') }}
              </button>
              <button
                class="hc-btn hc-btn-primary"
                :disabled="!formValid || submitting"
                @click="handleCreate"
              >
                <Loader v-if="submitting" :size="14" class="animate-spin" />
                <Save v-else :size="14" />
                {{ submitting ? t('tasks.creating', '编译中…') : t('common.create') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
  <PermissionApprovalModal
    :open="approvalOpen"
    :task-name="form.name"
    source="cron"
    :preflight="approvalPreflight"
    :busy="approvalBusy"
    @close="approvalOpen = false"
    @choose="onApprovalChoose"
  />
  <PermissionBlockedModal
    :open="blockedOpen"
    :task="blockedTask"
    @close="blockedOpen = false"
    @resolved="onBlockedResolved"
  />
  <ConfirmDialog
    :open="!!pendingDeleteJob"
    :title="t('tasks.deleteConfirmTitle', '删除任务？')"
    :message="pendingDeleteJob ? t('tasks.confirmDelete', { name: pendingDeleteJob.name }) : ''"
    :confirm-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    :confirmation-key="pendingDeleteJob?.id"
    danger
    @confirm="confirmDeleteJob"
    @cancel="pendingDeleteJob = null"
  />
</template>

<style scoped>
/* ── Task grid ── */
.tasks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  max-width: 1200px;
  /* Cards in the same row must not stretch to the tallest sibling — an
     expanded history on one card used to open a blank area on its neighbor. */
  align-items: start;
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
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
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

.task-card__perm-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  border: 0.5px solid rgba(240, 180, 41, 0.35);
  background: rgba(240, 180, 41, 0.12);
  color: var(--hc-warning, #e69500);
}
.task-card__perm-badge:hover {
  background: rgba(240, 180, 41, 0.2);
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
  /* Always reserve two lines so collapsed cards in a row are equal height
     (cards no longer stretch to siblings since align-items: start). */
  min-height: 3em;
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
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
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
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--hc-danger);
  margin-bottom: 4px;
}

.task-card__history-result {
  color: var(--hc-text-primary);
}

.task-card__history-data {
  margin: 6px 0;
  font-size: 12px;
  color: var(--hc-text-primary);
}
.task-card__history-data pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: var(--hc-bg-subtle, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
}

.task-card__history-stdout,
.task-card__history-stderr {
  margin-top: 4px;
}
.task-card__history-stderr pre,
.task-card__history-stdout pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: var(--hc-bg-subtle, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  max-height: 240px;
  overflow-y: auto;
}
.task-card__history-stderr pre {
  color: var(--hc-danger);
}
.task-card__history-toggle {
  background: none;
  border: none;
  padding: 0;
  color: var(--hc-accent);
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
}

.task-card__history-preview {
  margin-left: 8px;
  color: var(--hc-text-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-card__history-exit {
  font-size: 10px;
  color: var(--hc-warning);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  padding: 1px 4px;
  background: rgba(255, 165, 0, 0.1);
  border-radius: 3px;
}

/* Agent runtime badge (agent jobs have no compiled script panel) */
.task-card__agent-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 100px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
}

/* Compiled script viewer */
.task-card__script {
  margin: 8px 4px 0;
  padding: 10px 12px;
  background: var(--hc-bg-subtle, rgba(0, 0, 0, 0.04));
  border-radius: 8px;
  font-size: 12px;
}
.task-card__script-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--hc-text-secondary);
}
.task-card__script-meta--dim {
  color: var(--hc-text-muted);
  font-size: 10px;
}
.task-card__script-code {
  margin: 0;
  padding: 8px 10px;
  background: var(--hc-bg);
  border: 1px solid var(--hc-border, rgba(0, 0, 0, 0.08));
  border-radius: 6px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
}
.task-card__script-deps {
  margin-top: 6px;
  font-size: 10px;
  color: var(--hc-text-muted);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
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

/* ── SSE 编译进度条（cron 创建任务）─────── */
.hc-compile-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 20px;
  border-top: 1px solid var(--hc-divider);
  background: var(--hc-bg-subtle, rgba(0, 0, 0, 0.02));
}
.hc-compile-progress__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--hc-text-primary);
}
.hc-compile-progress__pct {
  margin-left: auto;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--hc-accent);
  font-weight: 500;
}
.hc-compile-progress__bar {
  height: 4px;
  background: var(--hc-divider);
  border-radius: 2px;
  overflow: hidden;
}
.hc-compile-progress__fill {
  height: 100%;
  background: var(--hc-accent);
  border-radius: 2px;
  transition: width 280ms cubic-bezier(0.4, 0, 0.2, 1);
}
.hc-compile-progress__msg {
  font-size: 11px;
  color: var(--hc-text-muted);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
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
  transition:
    background 0.15s,
    color 0.15s;
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
  transition:
    background 0.15s,
    border-color 0.15s;
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
  transition:
    background 0.15s,
    color 0.15s;
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

/* ── 投递目标 chips（§5 一处存处处引）── */
.deliver-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.deliver-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 100px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.deliver-chip:hover {
  border-color: var(--hc-accent);
}
.deliver-chip--on {
  background: var(--hc-accent-subtle);
  border-color: var(--hc-accent);
  color: var(--hc-accent);
}
.deliver-chip__provider {
  font-size: 10px;
  opacity: 0.65;
  text-transform: uppercase;
}
.deliver-sublabel {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin: 8px 0 6px;
}
.deliver-hint {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin: 8px 0 0;
}
.deliver-hint--error {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--hc-danger, #d64545);
}

.continuous-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--hc-text-secondary);
}
.continuous-toggle__cb {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--hc-primary, #4f46e5);
}

/* ── Transitions ── */
.modal-enter-active {
  transition: opacity 0.2s ease-out;
}
.modal-leave-active {
  transition: opacity 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.fade-enter-active {
  transition: opacity 0.15s ease-out;
}
.fade-leave-active {
  transition: opacity 0.1s ease-in;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
