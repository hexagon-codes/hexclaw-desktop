<script setup lang="ts">
/**
 * 拍照识题回显护栏面板（#1 · 原型 app.html #chatTutorView 的信任链上游兜底，PRD §3.2.5）。
 *
 * 流程：作业图片先固化 Asset，再由 store.dispatchImageTask 创建唯一 ImageTaskDispatch →
 * 服务端分类并推进内部目标链，前端只消费 facade 的公开停点与终态结果 →
 * 清晰内容自动推进，仅在 OCR 证据冲突时让家长核对并冻结修正 →
 * store.completeImageTask 读取同一 dispatch 的判别式结果。
 * 无年级时（冷启动首拍）据识出的知识点倒查课标推断年级建档（#3，store.coldStart）。
 *
 * 本层只做任务进度、风险确认与结果投影；不暴露逐题批改/求解等内部目标操作。
 */
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { nanoid } from 'nanoid'
import { useI18n } from 'vue-i18n'
import { useK12Store, type ImageTaskView } from '../store'
import { formatTime } from '@/utils/time'
import MessageActions from '@/components/chat/MessageActions.vue'
import MessageFooter from '@/components/chat/MessageFooter.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type { ActivityTimelineItem } from '@/components/chat/activity-timeline'
import CreativeWorkFeedbackRenderer from '../components/CreativeWorkFeedbackRenderer.vue'
import TaskProgressCard from '../components/TaskProgressCard.vue'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'
import HcSelect from '@/components/common/HcSelect.vue'
import VerifyBadge from '@/shell/chat/VerifyBadge.vue'
import TutoringTipsPanel from './TutoringTipsPanel.vue'
import PhotoGradeOverlay from './PhotoGradeOverlay.vue'
import SourceIssueResolver from '../components/SourceIssueResolver.vue'
import FinalArtifactActions from '../components/FinalArtifactActions.vue'
import { sourceIssueOperationLocked, type SourceIssueIntent } from '../source-issue'
import {
  k12GetImageTask,
  k12SubmitImageTaskProblemSourceAction,
  projectImageTaskProblemSourceActionSnapshot,
} from '@/api/k12'
import type { GradingFinalArtifactDTO } from '@/api/k12'
import type { FinalArtifactActionIntent } from '../final-artifact-action'
import { extractBriefFinalAnswer } from '../graded-photo'
import { k12QuestionSourceDisplayLabel } from '../source-display'
import { gradeToResult, gradeToVerify } from '../mappers'
import type {
  AnswerState,
  RecognizedQuestion,
  BBox,
  GradingQuestionCorrection,
  ImageTaskDispatchDTO,
  ImageTaskCoverageDTO,
  ImageTaskProblemProgressDTO,
  ImageTaskProblemSourceActionReq,
  ImageTaskProblemSourceActionResp,
  ImageTaskCreativeProjectionDTO,
  ImageTaskCreativeResultPayload,
  ImageTaskIntent,
  ParentTeachingGuideDTO,
  PhotoJobResult,
  ProblemKind,
  OCRConfirmationReason,
} from '@/api/k12'
import type { VerifyResult } from '@/contracts'
import type { ScenarioImageModelRoute } from '@/shell/scenario/registry'

// 审计单-High-2（bug-20260709）：本组件全部 API 调用的 agent = agents.name（后端隔离键），
// 故 prop 名就叫 agentId——曾命名 agentName 导致上游把 display_name 传进来，写错孩子作用域。
// initialImage（BUG-20260709 拍照发题不解题）：composer 粘贴/上传改道进来的图片 dataURL，
// 传入即预填并自动识题（原型契约「粘贴作业照片即自动 OCR 回显护栏」），家长零多余点击。
const props = defineProps<{
  agentId: string
  agentDisplayName?: string
  /** Legacy caller compatibility only; footer rendering never reads this mutable value. */
  displayProvider?: string
  /** Legacy caller compatibility only; footer rendering never reads this mutable value. */
  displayModel?: string
  grade?: string
  textbook?: string
  textbooks?: Partial<
    Record<'math' | 'chinese' | 'english' | 'science' | 'information_technology' | 'art', string>
  >
  initialImage?: string
  /** 会话显式选择的视觉路由请求；服务端按能力目录校验后才冻结到 Job。 */
  modelRoute?: ScenarioImageModelRoute
  /** §4.10 desktop request_id，与本次图片用户消息 ID 同源。 */
  requestId?: string
  /** TaskShell 在通用消息流中的稳定 source anchor。 */
  sourceMessageId?: string
  /** 刷新恢复时由多值 binding 精确指定，禁止按会话猜当前 dispatch。 */
  restoreDispatchId?: string
  /** 当前通用会话稳定 ID：只用于后端 source_session 与最小 Job 绑定恢复。 */
  sessionId?: string
  /** 当前图片消息的可选意图提示；仅作为分类证据，不替代服务端裁决。 */
  messageIntent?: string
}>()
// close：面板自动打开（图片改道）后由头部 ✕ 收起——手动 toggle 已删（BUG-20260711-E），
// 收起手段必须内聚在面板自身。
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'contentUpdated'): void
  /**
   * 用户主动重试必须由会话 shell 创建新的消息/request_id，并重新冻结当前模型路由。
   * 组件绝不能把旧 Job 的 request_id 原地重放，否则模型改绑后会撞上不可变调用账本。
   */
  (e: 'retry'): void
  (e: 'sourceIssueIntent', intent: SourceIssueIntent): void
  (e: 'finalArtifactAction', intent: FinalArtifactActionIntent): void
  (
    e: 'update:executionState',
    payload: {
      sessionId: string
      executionId: string
      state: string
      automaticBudgetSeconds?: number
      automaticStartedAt?: number
      automaticDeadlineAt?: number
      operationDeadlineAt?: number
    },
  ): void
}>()

const { t } = useI18n()
const store = useK12Store()
// Shell 正常路径传入与持久消息同源的 request_id；独立/兼容挂载也只生成一次请求身份，
// 绝不退回“同图同 key”的内容哈希。
const generatedRequestId = nanoid(12)
const effectiveRequestId = computed(() => props.requestId?.trim() || generatedRequestId)

/** 一道识出的题在护栏里的可编辑本地状态 */
interface GuardRow {
  problemId: string
  problemKind: ProblemKind
  parentProblemId: string
  subproblemNo: string
  sourceNumberPath: string[]
  displayLabel: string
  sourceSectionPath: string[]
  sourceSectionLabel: string
  systemSectionOrdinal: number
  systemDisplayLabel: string
  attemptId: string
  rawProblem: string
  problem: string // 家长可就地订正的题干（初值=识别原文）
  canonicalVersion: number
  knowledgePoints: string[]
  editing: boolean
  rawStudentAnswer: string
  studentAnswer: string
  answerState: AnswerState
  confirmationRequired: boolean
  confirmationReasons: OCRConfirmationReason[]
  recognitionConfirmed: boolean
  verify: VerifyResult | null
  recorded: boolean
  recordDeduplicated: boolean
  solution: string
  wrongStep: string
  errorCause: string
  /** completed_homework 错题的完整家长讲法；正确题必须为空。 */
  parentGuide: ParentTeachingGuideDTO | null
  // 独立锚定阶段回收的学生作答区域归一化边界框（缺失/非法=null → 该题降级纯文字批改，不叠加）。
  bbox: BBox | null
  // graded=true 表示本题走了「批改」（已答卷路径），供原图叠加只画已批改题的 ✓/✗；solve（空白题求解）不叠加。
  graded: boolean
  // verdict 存后端批改判定五值（agree=对/disagree=错；布尔 correct 已随契约删除），
  // 叠加层据此画 ✓（绿）/✗（红）。
  verdict: string
  // INV-007：verdict=agree 的正确题解法详情默认折叠（单行摘要），家长点击展开。
  // disagree/unverifiable 需家长关注 → 不折叠；solve 路径（graded=false）也不折叠。
  expanded: boolean
}

const imageB64 = ref('')
// 服务端不可变批注图；为空时 PhotoGradeOverlay 才使用原图+bbox 的兼容叠加。
const annotatedImage = ref('')
/**
 * K12-INV-060 has a distinct, parent-facing result projection. It is only
 * populated from the typed completed-job contract; rows remain the legacy
 * completed-homework/recognition projection and are not repurposed as a
 * blank-worksheet UI.
 */
interface BlankWorksheetGuideItem {
  problemId: string
  question: string
  guide: ParentTeachingGuideDTO
}
const blankWorksheetGuide = ref<BlankWorksheetGuideItem[]>([])
const hasBlankWorksheetGuide = computed(() => blankWorksheetGuide.value.length > 0)
// BUG-20260712：选了文件/贴了图片 data URL 时显示缩略图预览，不再把 base64 原文糊在框里（UX 糙）。
const isImageData = computed(() => imageB64.value.trim().startsWith('data:image'))
const rows = ref<GuardRow[]>([])
const problemProgressSlots = ref<ImageTaskProblemProgressDTO[]>([])
const taskCoverage = ref<ImageTaskCoverageDTO | null>(null)
const finalArtifact = ref<GradingFinalArtifactDTO | null>(null)
const frozenProviderDisplayName = ref('')
const frozenModelID = ref('')
const currentStructureVersion = ref(0)
const pendingSourceProblemIds = ref(new Set<string>())
const sourceActionIdempotencyKeys = new Map<string, string>()
const sourceActionControllers = new Set<AbortController>()
const recognizing = ref(false)
const anchoring = ref(false)
const anchorWarning = ref('')
const errMsg = ref('')
const recognitionFailed = ref(false)
const retryable = ref(false)
const retrySubmitting = ref(false)
const currentTaskStage = ref('')
const taskCreatedAt = ref<number>()
const taskUpdatedAt = ref<number>()
const automaticBudgetSeconds = ref<number>()
const automaticStartedAt = ref<number>()
const automaticDeadlineAt = ref<number>()
const operationDeadlineAt = ref<number>()
const runtimeNowSeconds = ref(Math.floor(Date.now() / 1000))
let runtimeClock: ReturnType<typeof setInterval> | null = null
const confirmed = ref(false)
const correctionMode = ref(false)
const selectedSubject = ref('')
const subjectTextbookKeys: Record<
  string,
  'math' | 'chinese' | 'english' | 'science' | 'information_technology' | 'art'
> = {
  数学: 'math',
  语文: 'chinese',
  英语: 'english',
  科学: 'science',
  信息科技: 'information_technology',
  美术: 'art',
}
const activeTextbook = computed(() => {
  const key = subjectTextbookKeys[selectedSubject.value]
  if (!key) return props.textbook || ''
  return props.textbooks?.[key] || (key === 'math' ? props.textbook || '' : '')
})
const batchWorking = ref(false)
const confirming = ref(false)
// Desktop 只持有 facade identity/version；服务端内部目标身份不泄露到客户端。
const currentDispatchId = ref('')
const currentDispatchVersion = ref(0)

const executionId = computed(() => props.sourceMessageId?.trim() || effectiveRequestId.value)
const elapsedSeconds = computed(() =>
  automaticStartedAt.value === undefined
    ? 0
    : Math.max(0, runtimeNowSeconds.value - automaticStartedAt.value),
)
const activeStageBudgetSeconds = computed(() => {
  if (automaticStartedAt.value !== undefined && operationDeadlineAt.value !== undefined) {
    return Math.max(0, operationDeadlineAt.value - automaticStartedAt.value)
  }
  return 60
})
const activeStageTimingText = computed(
  () =>
    `已等待 ${formatDuration(elapsedSeconds.value)} · 阶段预算 ${activeStageBudgetSeconds.value} 秒`,
)

function formatDuration(totalSeconds: number): string {
  const normalized = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(normalized / 60)
  const seconds = normalized % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function syncExecutionState(state: string): void {
  const sessionId = props.sessionId?.trim()
  const normalizedExecutionId = executionId.value.trim()
  if (!sessionId || !normalizedExecutionId) return
  emit('update:executionState', {
    sessionId,
    executionId: normalizedExecutionId,
    state,
    automaticBudgetSeconds: automaticBudgetSeconds.value,
    automaticStartedAt: automaticStartedAt.value,
    automaticDeadlineAt: automaticDeadlineAt.value,
    operationDeadlineAt: operationDeadlineAt.value,
  })
}

function projectRuntimeTiming(dispatch: ImageTaskDispatchDTO): void {
  automaticBudgetSeconds.value = dispatch.automatic_budget_seconds
  automaticStartedAt.value = dispatch.automatic_started_at
  automaticDeadlineAt.value = dispatch.automatic_deadline_at
  operationDeadlineAt.value = dispatch.operation_deadline_at
  runtimeNowSeconds.value = Math.floor(Date.now() / 1000)
}
const currentTaskIntent = ref<ImageTaskIntent>('unknown')
interface CreativeConflictRow {
  segmentId: string
  rawText: string
  editedText: string
  reason: string
  confirmed: boolean
  editing: boolean
}
const creativeProjection = ref<ImageTaskCreativeProjectionDTO | null>(null)
const creativeConflicts = ref<CreativeConflictRow[]>([])
const creativeResult = ref<{
  taskIntent: 'writing' | 'artwork'
  payload: ImageTaskCreativeResultPayload
} | null>(null)
const collapsed = ref(false)
const taskShellTitle = computed(() => {
  if (currentTaskIntent.value === 'completed_homework') return '已作答作业'
  if (currentTaskIntent.value === 'blank_worksheet') return '空白卷 · 家长讲题指南'
  if (currentTaskIntent.value === 'writing') return '语文写作'
  if (currentTaskIntent.value === 'artwork') return '美术作品'
  return '图片任务'
})
const taskProviderDisplayName = computed(() => frozenProviderDisplayName.value)
const taskModelDisplayName = computed(() => frozenModelID.value)
const taskTimeDisplay = computed(() => {
  if (!taskCreatedAt.value) return ''
  const timestamp =
    taskCreatedAt.value < 1_000_000_000_000 ? taskCreatedAt.value * 1000 : taskCreatedAt.value
  return formatTime(new Date(timestamp).toISOString())
})
const showTaskFooter = computed(
  () =>
    !!currentDispatchId.value &&
    !['completed', 'feedback_ready', 'promoted', 'cancelled'].includes(currentTaskStage.value),
)
const showTaskRetry = computed(
  () =>
    currentTaskStage.value === 'failed_retryable' &&
    retryable.value &&
    !retrySubmitting.value &&
    !outcomeUnknown.value,
)
const unconfirmedCreativeConflictCount = computed(
  () => creativeConflicts.value.filter((conflict) => !conflict.confirmed).length,
)
// recovering 仅表示同一个图片任务正在恢复；不是终态，也不提供二次操作入口。
const outcomeUnknown = ref(false)
const isWithSkips = computed(() => taskCoverage.value?.state === 'with_skips')
const skippedProblems = computed(() => problemProgressSlots.value.filter(problemIsSkipped))
const finalArtifactID = computed(() => {
  const artifactID = finalArtifact.value?.artifact_id
  return typeof artifactID === 'string' ? artifactID.trim() : ''
})
const finalArtifactDigest = computed(() => {
  const digest = finalArtifact.value?.artifact_digest
  return typeof digest === 'string' ? digest.trim() : ''
})
const finalArtifactTitle = computed(() => {
  const title = finalArtifact.value?.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  if (isWithSkips.value) {
    return `整页批改完成 · 有 ${taskCoverage.value?.skipped ?? 0} 题跳过`
  }
  return '整页批改完成'
})

interface SingleProblemProgressItem {
  kind: 'problem'
  key: string
  problem: ImageTaskProblemProgressDTO
}

interface GroupProblemProgressItem {
  kind: 'group'
  key: string
  groupId: string
  displayLabel: string
  ordinal: number
  problems: ImageTaskProblemProgressDTO[]
}

type ProblemProgressItem = SingleProblemProgressItem | GroupProblemProgressItem

const SOURCE_ORDINALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

function sourceOrdinal(problem: ImageTaskProblemProgressDTO): number {
  if (problem.system_section_ordinal > 0) return problem.system_section_ordinal
  const source = problem.source_number_path[0] ?? ''
  const numeric = Number.parseInt(source, 10)
  return Number.isFinite(numeric) ? numeric : (SOURCE_ORDINALS[source] ?? 0)
}

function problemProgressDisplayLabel(problem: ImageTaskProblemProgressDTO): string {
  return k12QuestionSourceDisplayLabel(problem)
}

const problemProgressItems = computed<ProblemProgressItem[]>(() => {
  const projected: ProblemProgressItem[] = []
  const consumedGroups = new Set<string>()
  for (const problem of problemProgressSlots.value) {
    const groupId = problem.dependency_group_id?.trim()
    if (!groupId) {
      projected.push({
        kind: 'problem',
        key: problem.problem_id,
        problem,
      })
      continue
    }
    if (consumedGroups.has(groupId)) continue
    consumedGroups.add(groupId)
    const problems = problemProgressSlots.value.filter(
      (candidate) => candidate.dependency_group_id === groupId,
    )
    const parent = rows.value.find((row) => row.problemId === problem.parent_problem_id)
    projected.push({
      kind: 'group',
      key: `group:${groupId}`,
      groupId,
      displayLabel: parent ? rowLabel(parent, 0) : problemProgressDisplayLabel(problem),
      ordinal: sourceOrdinal(problem),
      problems,
    })
  }
  return projected
})

function problemIsSkipped(problem: ImageTaskProblemProgressDTO): boolean {
  return problem.operation_state === 'skipped' || problem.disposition_state === 'skipped_by_parent'
}

function problemNeedsResolver(problem: ImageTaskProblemProgressDTO): boolean {
  return problem.source_state === 'awaiting_resolution' || problemIsSkipped(problem)
}

function resolverDisabled(problems: ImageTaskProblemProgressDTO[]): boolean {
  return problems.some(
    (problem) =>
      pendingSourceProblemIds.value.has(problem.problem_id) ||
      problem.command_available === false ||
      sourceIssueOperationLocked(problem.operation_state),
  )
}

function expectedInputRevision(problems: ImageTaskProblemProgressDTO[]): number {
  return Math.max(
    0,
    ...problems.map((problem) => problem.input_revision ?? problem.published_revision),
  )
}

function problemProgressStatus(problem: ImageTaskProblemProgressDTO): string {
  if (problemIsSkipped(problem)) return '已跳过 · 未判断对错'
  if (problem.source_state === 'awaiting_resolution') return '等待处理题源问题'
  if (problem.operation_state === 'outcome_unknown') return '正在恢复处理结果'
  if (problem.disposition_state === 'result') return '已批改'
  return '处理中'
}

function sourceActionRequest(intent: SourceIssueIntent): ImageTaskProblemSourceActionReq | null {
  if (intent.action === 'skip' || intent.action === 'resume') {
    return {
      action: intent.action,
      structure_version: intent.structure_version,
      expected_input_revision: intent.expected_input_revision,
      payload: {},
    }
  }
  if (intent.action === 'correct_recognition') {
    const corrected = intent.payload?.corrected_text?.trim()
    if (!corrected) return null
    return {
      action: 'correct_text',
      structure_version: intent.structure_version,
      expected_input_revision: intent.expected_input_revision,
      payload: { question_canonical_markdown: corrected },
    }
  }
  return null
}

function updatePendingSourceProblems(problemIds: string[], pending: boolean) {
  const next = new Set(pendingSourceProblemIds.value)
  for (const problemId of problemIds) {
    if (pending) next.add(problemId)
    else next.delete(problemId)
  }
  pendingSourceProblemIds.value = next
}

function applyProblemSourceSnapshot(response: ImageTaskProblemSourceActionResp) {
  if (response.dispatch_id !== currentDispatchId.value) return
  const snapshot = projectImageTaskProblemSourceActionSnapshot(
    response,
    problemProgressSlots.value,
  )
  currentStructureVersion.value = snapshot.structure_version
  problemProgressSlots.value = snapshot.problem_progress
  taskCoverage.value = snapshot.coverage
}

function sourceActionStatus(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object') return undefined
  const error = cause as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  for (const value of [error.status, error.statusCode, error.response?.status]) {
    if (typeof value === 'number') return value
  }
  return undefined
}

async function applyLocalSourceIntent(intent: SourceIssueIntent) {
  const dispatchId = currentDispatchId.value
  const problemId = intent.problem_ids[0]?.trim()
  const request = sourceActionRequest(intent)
  if (!dispatchId || !problemId || !request) return
  if (intent.problem_ids.some((id) => pendingSourceProblemIds.value.has(id))) return

  emit('sourceIssueIntent', intent)
  updatePendingSourceProblems(intent.problem_ids, true)
  errMsg.value = ''
  const fingerprint = `${dispatchId}:${problemId}:${JSON.stringify(request)}`
  let idempotencyKey = sourceActionIdempotencyKeys.get(fingerprint)
  if (!idempotencyKey) {
    idempotencyKey = `source-action-${nanoid(24)}`
    sourceActionIdempotencyKeys.set(fingerprint, idempotencyKey)
  }
  const controller = new AbortController()
  sourceActionControllers.add(controller)
  try {
    const response = await k12SubmitImageTaskProblemSourceAction(
      dispatchId,
      problemId,
      request,
      idempotencyKey,
      controller.signal,
    )
    applyProblemSourceSnapshot(response)
  } catch (cause) {
    if (sourceActionStatus(cause) === 409 && !controller.signal.aborted) {
      try {
        const current = await k12GetImageTask(props.agentId, dispatchId, controller.signal)
        if (currentDispatchId.value === dispatchId) {
          projectImageTaskDispatch(current.dispatch)
        }
      } catch (refreshCause) {
        if (!controller.signal.aborted) {
          errMsg.value = refreshCause instanceof Error ? refreshCause.message : String(refreshCause)
        }
      }
    } else if (!controller.signal.aborted) {
      errMsg.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    sourceActionControllers.delete(controller)
    updatePendingSourceProblems(intent.problem_ids, false)
  }
}

const taskContentProjection = computed(() =>
  [
    currentTaskStage.value,
    recognizing.value ? 'recognizing' : '',
    anchoring.value ? 'anchoring' : '',
    batchWorking.value ? 'working' : '',
    recognitionFailed.value ? 'failed' : '',
    outcomeUnknown.value ? 'outcome-unknown' : '',
    anchorWarning.value,
    errMsg.value,
    rows.value.length,
    problemProgressSlots.value
      .map((problem) => `${problem.problem_id}:${problem.published_revision}`)
      .join(','),
    taskCoverage.value
      ? `${taskCoverage.value.state}:${taskCoverage.value.processed}:${taskCoverage.value.skipped}`
      : '',
    finalArtifactDigest.value,
    blankWorksheetGuide.value.length,
    annotatedImage.value.length,
    creativeProjection.value ? 'creative-projection' : '',
    creativeConflicts.value.length,
    creativeResult.value ? 'creative-result' : '',
  ].join('|'),
)
watch(taskContentProjection, () => emit('contentUpdated'), { flush: 'post' })
const restoredFromBinding = ref(false)
let agentGeneration = 0
let recognitionGeneration = 0
let recognitionAbort: AbortController | null = null
let restoreAbort: AbortController | null = null
let confirmationAbort: AbortController | null = null
let gradingAbort: AbortController | null = null
const subjectOptions = computed(() =>
  K12_GRADE_SUBJECT_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  })),
)

function enterOutcomeUnknown(dispatchId: string) {
  currentDispatchId.value = dispatchId
  outcomeUnknown.value = true
  batchWorking.value = true
  recognizing.value = false
  anchoring.value = false
  recognitionFailed.value = false
  errMsg.value = ''
}

// 冷启动倒查建档（#3）：仅在无年级时可用（识题产出知识点后倒查推断）
const coldStarting = ref(false)
const coldStartResult = ref<{ grade: string; inferred: boolean } | null>(null)
const noGrade = computed(() => !props.grade || !props.grade.trim())
const canColdStart = computed(
  () => noGrade.value && rows.value.length > 0 && !coldStartResult.value,
)
// 汇总所有识题知识点（去重、保序）供倒查
const allKnowledgePoints = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows.value)
    for (const kp of r.knowledgePoints)
      if (!seen.has(kp)) {
        seen.add(kp)
        out.push(kp)
      }
  return out
})

// 原图批改叠加（Phase 1）：批改完成后，把已批改题的对/错 + bbox 投给 PhotoGradeOverlay。
// bbox 合理性由叠加组件自己兜底（缺失/非法 → 降级文字批改，不错位），此处只喂数据不做几何判断。
const overlayMarks = computed(() =>
  rows.value
    .filter((r) => r.graded && r.verify)
    .map((r) => ({
      // 判定五值 → 叠加符号（agree=✓；其余已批改判定按 ✗/超纲处理，超纲由 outOfScope 拦）。
      correct: r.verdict === 'agree',
      // 超纲只表示“当前学段不应批改”，绝不是孩子答错；叠加层据此禁止画红叉。
      outOfScope: r.verify?.verdict === 'out_of_scope',
      bbox: r.bbox,
      source_number_path: r.sourceNumberPath,
      display_label: r.displayLabel,
      source_section_path: r.sourceSectionPath,
      source_section_label: r.sourceSectionLabel,
      system_section_ordinal: r.systemSectionOrdinal,
      system_display_label: r.systemDisplayLabel,
      question: r.problem,
      // solution 可能是整段 Markdown 推导；原图上只显示简短最终答案。
      correctAnswer: extractBriefFinalAnswer(r.solution),
      errorCause: r.errorCause,
      parentGuide: r.parentGuide,
    })),
)

const SAFE_ANNOTATED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** 后端 wire 的原始 base64 → WebView 可直接加载的安全 data URL；非法值严格回退 bbox 叠加。 */
function annotatedImageDataURL(value: PhotoJobResult['annotated_image']): string {
  const mime = value?.mime.trim().toLowerCase() ?? ''
  const payload = value?.data_base64.replace(/\s/g, '') ?? ''
  if (
    !SAFE_ANNOTATED_IMAGE_MIMES.has(mime) ||
    !payload ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    return ''
  }
  return `data:${mime};base64,${payload}`
}

function hasGuideTextList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.trim())
  )
}

/** Accept the exact seven-field guide shape before switching away from grade UI. */
function isParentTeachingGuide(value: unknown): value is ParentTeachingGuideDTO {
  if (!value || typeof value !== 'object') return false
  const guide = value as Partial<ParentTeachingGuideDTO>
  return (
    typeof guide.answer === 'string' &&
    !!guide.answer.trim() &&
    hasGuideTextList(guide.full_solution_steps) &&
    typeof guide.grade_level_method === 'string' &&
    !!guide.grade_level_method.trim() &&
    hasGuideTextList(guide.likely_mistakes) &&
    hasGuideTextList(guide.parent_teaching_sequence) &&
    hasGuideTextList(guide.follow_up_questions) &&
    typeof guide.checking_method === 'string' &&
    !!guide.checking_method.trim()
  )
}

function parentTeachingGuideItems(result: PhotoJobResult): BlankWorksheetGuideItem[] {
  if (result.task_intent !== 'blank_worksheet') return []
  if (
    result.result_surface !== 'parent_teaching_guide' ||
    result.items.length === 0 ||
    result.items.some(
      (item) =>
        item.status !== 'blank_solved' ||
        item.result_kind !== 'parent_teaching_guide' ||
        !isParentTeachingGuide(item.parent_guide),
    )
  ) {
    // A whole-sheet guide is one atomic result. Never present a filtered
    // subset as though the page had been completely solved.
    throw new Error('invalid blank worksheet parent guide')
  }
  return result.items.map((item) => ({
    problemId: item.question.problem_id ?? '',
    // The recognized display question is the frozen original-order label.
    // Canonical Markdown is reserved for formula-bearing body content and
    // may be a delimiter-free transport form, so never expose it raw here.
    question: item.question.question || item.question.canonical_markdown || '',
    guide: item.parent_guide as ParentTeachingGuideDTO,
  }))
}

// 新服务优先展示不可变批注图；老服务缺字段时保留原图+bbox 确定性叠加兼容。
const showOverlay = computed(
  () => !!annotatedImage.value || (isImageData.value && overlayMarks.value.length > 0),
)
const unclearAnswerCount = computed(
  () =>
    rows.value.filter(
      (row) => isAnswerable(row) && row.problem.trim() && row.answerState === 'unclear',
    ).length,
)
const riskCount = computed(() => rows.value.filter((row) => row.confirmationRequired).length)
const unconfirmedRiskCount = computed(
  () => rows.value.filter((row) => row.confirmationRequired && !row.recognitionConfirmed).length,
)
const homeworkResultAnchor = ref<HTMLElement | null>(null)
const homeworkTaskProgressState = computed<'running' | 'completed' | null>(() => {
  if (
    currentTaskIntent.value !== 'completed_homework' ||
    !taskCoverage.value ||
    outcomeUnknown.value ||
    recognitionFailed.value
  ) {
    return null
  }
  if (currentTaskStage.value === 'completed') return 'completed'
  return batchWorking.value ? 'running' : null
})
const homeworkCurrentProblemNumber = computed(() => {
  const pendingIndex = problemProgressSlots.value.findIndex(
    (problem) => !problemIsSkipped(problem) && problem.disposition_state !== 'result',
  )
  if (pendingIndex >= 0) return pendingIndex + 1
  const coverage = taskCoverage.value
  if (coverage && coverage.processed < coverage.total) {
    return Math.min(coverage.total, coverage.processed + 1)
  }
  return 0
})
const homeworkCompletedDurationSeconds = computed(() => {
  if (automaticStartedAt.value === undefined || taskUpdatedAt.value === undefined) return 0
  const updatedAt =
    taskUpdatedAt.value > 1_000_000_000_000
      ? Math.floor(taskUpdatedAt.value / 1000)
      : Math.floor(taskUpdatedAt.value)
  return Math.max(0, updatedAt - automaticStartedAt.value)
})
const homeworkTaskSummary = computed(() => {
  const coverage = taskCoverage.value
  const state = homeworkTaskProgressState.value
  if (!coverage || !state) return ''
  if (state === 'completed') {
    const minutes = Math.floor(homeworkCompletedDurationSeconds.value / 60)
    const seconds = homeworkCompletedDurationSeconds.value % 60
    return `作业批改完成　${coverage.total} 题　·　${riskCount.value} 题需确认　·　用时 ${minutes} 分 ${seconds} 秒`
  }
  return `正在批改作业　${coverage.processed}/${coverage.total}　·　${riskCount.value} 题需确认　·　已用时 ${formatDuration(elapsedSeconds.value)}`
})
const homeworkTimelineItems = computed<ActivityTimelineItem[]>(() => {
  if (!homeworkTaskProgressState.value) return []
  const items: ActivityTimelineItem[] = [
    {
      id: 'structure-frozen',
      state: 'completed',
      label: '题目结构已冻结',
    },
  ]
  if (homeworkTaskProgressState.value === 'running' && homeworkCurrentProblemNumber.value > 0) {
    items.push({
      id: 'grading-current',
      state: 'running',
      label: `正在批改第 ${homeworkCurrentProblemNumber.value} 题`,
      detail: `阶段预算 ${activeStageBudgetSeconds.value} 秒`,
    })
  }
  return items
})

function viewHomeworkResult(): void {
  homeworkResultAnchor.value?.scrollIntoView({ block: 'nearest' })
  homeworkResultAnchor.value?.focus({ preventScroll: true })
}

const OCR_RISK_LABELS: Record<OCRConfirmationReason, string> = {
  fraction: '分数线',
  decimal_point: '小数点',
  negative_sign: '负号',
  unit: '单位',
  erasure: '涂改痕迹',
  evidence_conflict: '多次识别不一致',
  low_confidence: '识别置信度较低',
  unclear_handwriting: '字迹未读清',
  subject_undetermined: '学科未确定',
  canonical_parse_failed: '公式解析失败',
}

function isAnswerable(row: GuardRow): boolean {
  return row.problemKind !== 'compound_parent'
}

function riskLabel(reason: OCRConfirmationReason): string {
  return OCR_RISK_LABELS[reason] ?? reason
}

function rowLabel(row: GuardRow, index: number): string {
  void index
  const source = k12QuestionSourceDisplayLabel({
    display_label: row.displayLabel,
    source_section_label: row.sourceSectionLabel,
    system_display_label: row.systemDisplayLabel,
  })
  if (source) return source
  if (row.problemKind === 'compound_parent') return '公共题干'
  return ''
}

function normalizeAnswerState(question: RecognizedQuestion): AnswerState {
  if (
    question.answer_state === 'blank' ||
    question.answer_state === 'present' ||
    question.answer_state === 'unclear'
  ) {
    return question.answer_state
  }
  // 滚动升级兼容旧 sidecar：只按可见答案文本兜底，绝不再从 bbox 猜“空白/没读清”。
  return question.student_answer?.trim() ? 'present' : 'blank'
}

function guardRowsFromQuestions(questions: RecognizedQuestion[]): GuardRow[] {
  return questions.map((question) => ({
    problemId: question.problem_id ?? '',
    problemKind: question.problem_kind ?? 'standalone',
    parentProblemId: question.parent_problem_id ?? '',
    subproblemNo: question.subproblem_no ?? '',
    sourceNumberPath: question.source_number_path ?? [],
    displayLabel: question.display_label ?? '',
    sourceSectionPath: question.source_section_path ?? [],
    sourceSectionLabel: question.source_section_label ?? '',
    systemSectionOrdinal: question.system_section_ordinal ?? 0,
    systemDisplayLabel: question.system_display_label ?? '',
    attemptId: question.attempt_id ?? '',
    rawProblem: question.raw_transcription ?? question.question,
    problem: question.canonical_markdown ?? question.question,
    canonicalVersion: question.canonical_version ?? 1,
    knowledgePoints: question.knowledge_points ?? [],
    editing: false,
    rawStudentAnswer: question.answer_raw_transcription ?? question.student_answer ?? '',
    studentAnswer: question.answer_canonical_markdown ?? question.student_answer ?? '',
    answerState: normalizeAnswerState(question),
    confirmationRequired: question.confirmation_required ?? false,
    confirmationReasons: question.confirmation_reasons ?? [],
    recognitionConfirmed: !(question.confirmation_required ?? false),
    verify: null,
    recorded: false,
    recordDeduplicated: false,
    solution: '',
    wrongStep: '',
    errorCause: '',
    parentGuide: null,
    bbox: question.bbox ?? null,
    graded: false,
    verdict: '',
    expanded: false,
  }))
}

function projectCreativeIntake(projection?: ImageTaskCreativeProjectionDTO) {
  if (
    currentTaskIntent.value !== 'writing' ||
    projection?.work_type !== 'writing' ||
    projection.status !== 'awaiting_confirmation'
  ) {
    creativeProjection.value = projection ?? null
    creativeConflicts.value = []
    return
  }

  const previous = new Map(
    creativeConflicts.value.map((conflict) => [conflict.segmentId, conflict]),
  )
  creativeProjection.value = projection
  creativeConflicts.value = (projection.conflicts ?? []).map((conflict) => {
    const prior = previous.get(conflict.segment_id)
    const source = (conflict.raw_text || conflict.canonical_text || '').trim()
    return {
      segmentId: conflict.segment_id,
      rawText: source,
      editedText: prior?.editedText ?? (conflict.canonical_text || source).trim(),
      reason: conflict.reason ?? '',
      confirmed: prior?.confirmed ?? false,
      editing: prior?.editing ?? false,
    }
  })
}

function projectImageTaskView(view: ImageTaskView) {
  currentDispatchId.value = view.dispatchId
  currentDispatchVersion.value = view.dispatchVersion
  currentTaskStage.value = view.stage
  taskCreatedAt.value = view.createdAt
  automaticBudgetSeconds.value = view.automaticBudgetSeconds
  automaticStartedAt.value = view.automaticStartedAt
  automaticDeadlineAt.value = view.automaticDeadlineAt
  operationDeadlineAt.value = view.operationDeadlineAt
  runtimeNowSeconds.value = Math.floor(Date.now() / 1000)
  syncExecutionState(view.stage)
  currentTaskIntent.value = view.taskIntent
  projectCreativeIntake(view.creative)
  retryable.value = view.retryable === true && view.stage === 'failed_retryable'
  recognitionFailed.value = ['failed_retryable', 'failed_terminal', 'feedback_failed'].includes(
    view.stage,
  )
  errMsg.value = recognitionFailed.value ? t('k12.recognize.jobFailed') : ''

  const questions = view.questions
  if (questions.length && !rows.value.length) rows.value = guardRowsFromQuestions(questions)
  if (!selectedSubject.value && view.subject) {
    selectedSubject.value = view.subject
  }

  const recognitionStages = ['queued', 'normalizing', 'recognizing']
  recognizing.value =
    recognitionStages.includes(view.stage) || (view.stage === 'locating' && !rows.value.length)
  anchoring.value = view.anchorState === 'pending' && !!rows.value.length
  anchorWarning.value = view.anchorState === 'degraded' ? t('k12.recognize.anchorFailed') : ''
  confirmed.value = view.confirmationState === 'confirmed'
  outcomeUnknown.value = view.stage === 'recovering' || view.stage === 'outcome_unknown'
  batchWorking.value =
    outcomeUnknown.value ||
    ['assessing', 'rendering', 'projecting', 'feedback_pending'].includes(view.stage)
  if (outcomeUnknown.value) {
    recognizing.value = false
    anchoring.value = false
  }
}

function projectImageTaskDispatch(dispatch: ImageTaskDispatchDTO) {
  currentDispatchId.value = dispatch.dispatch_id
  currentDispatchVersion.value = dispatch.version
  frozenProviderDisplayName.value = dispatch.provider_display_name?.trim() ?? ''
  frozenModelID.value = dispatch.model_id?.trim() ?? ''
  taskCreatedAt.value = dispatch.created_at
  taskUpdatedAt.value = dispatch.updated_at
  projectRuntimeTiming(dispatch)
  currentTaskIntent.value = dispatch.task_intent
  const projection = dispatch.target_projection
  currentTaskStage.value =
    projection?.kind === 'homework'
      ? projection.stage
      : projection?.kind === 'creative' && dispatch.progress.operation === 'promotion'
        ? dispatch.progress.state
        : projection?.kind === 'creative'
          ? projection.status
          : dispatch.status
  syncExecutionState(currentTaskStage.value)
  retryable.value = dispatch.retryable === true && currentTaskStage.value === 'failed_retryable'
  if (projection?.kind === 'homework') {
    taskCoverage.value = projection.coverage ?? null
    finalArtifact.value = projection.final_artifact ?? null
    currentStructureVersion.value = projection.structure_version ?? 0
    const sourceOrder = new Map(
      (projection.recognition?.questions ?? []).map((question, index) => [
        question.problem_id,
        index,
      ]),
    )
    problemProgressSlots.value = [...(projection.problems ?? [])].sort((left, right) => {
      const leftIndex = sourceOrder.get(left.problem_id) ?? Number.MAX_SAFE_INTEGER
      const rightIndex = sourceOrder.get(right.problem_id) ?? Number.MAX_SAFE_INTEGER
      if (leftIndex !== rightIndex) return leftIndex - rightIndex
      return left.source_number_path
        .join('.')
        .localeCompare(right.source_number_path.join('.'), undefined, { numeric: true })
    })
    projectImageTaskView({
      dispatchId: dispatch.dispatch_id,
      dispatchVersion: dispatch.version,
      createdAt: dispatch.created_at,
      automaticBudgetSeconds: dispatch.automatic_budget_seconds,
      automaticStartedAt: dispatch.automatic_started_at,
      automaticDeadlineAt: dispatch.automatic_deadline_at,
      automaticRemainingSeconds: dispatch.automatic_remaining_seconds,
      operationDeadlineAt: dispatch.operation_deadline_at,
      taskIntent: dispatch.task_intent,
      stage: projection.stage,
      retryable: dispatch.retryable === true,
      questions: projection.recognition?.questions ?? [],
      subject: projection.recognition?.subject ?? '',
      anchorState: projection.anchor_state,
      confirmationState: projection.confirmation_state,
      creative: undefined,
      intentCandidates: dispatch.confirmation_candidates,
    })
    return
  }
  problemProgressSlots.value = []
  taskCoverage.value = null
  finalArtifact.value = null
  currentStructureVersion.value = 0
  projectCreativeIntake(projection?.kind === 'creative' ? projection : undefined)
  const feedbackState =
    projection?.kind === 'creative' && dispatch.progress.operation === 'promotion'
      ? dispatch.progress.state
      : ''
  recognitionFailed.value = dispatch.status === 'failed' || feedbackState === 'feedback_failed'
  errMsg.value = recognitionFailed.value ? t('k12.recognize.jobFailed') : ''
  recognizing.value =
    dispatch.status === 'routing' ||
    (projection?.kind === 'creative' && projection.status === 'preparing')
  outcomeUnknown.value = feedbackState === 'recovering'
  batchWorking.value =
    recognizing.value ||
    outcomeUnknown.value ||
    feedbackState === 'feedback_pending' ||
    (projection?.kind === 'creative' &&
      (projection.status === 'ready' || projection.status === 'awaiting_confirmation'))
}

function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    imageB64.value = String(reader.result ?? '')
  }
  reader.readAsDataURL(file)
}

// 多孩切换是状态边界：立即清空本地识题态，并让旧 agent 的在途响应失效。
watch(
  () => props.agentId,
  () => {
    agentGeneration += 1
    recognitionGeneration += 1
    restoreAbort?.abort()
    restoreAbort = null
    confirmationAbort?.abort()
    confirmationAbort = null
    gradingAbort?.abort()
    gradingAbort = null
    recognitionAbort?.abort()
    recognitionAbort = null
    imageB64.value = ''
    annotatedImage.value = ''
    blankWorksheetGuide.value = []
    rows.value = []
    problemProgressSlots.value = []
    taskCoverage.value = null
    finalArtifact.value = null
    currentStructureVersion.value = 0
    recognizing.value = false
    anchoring.value = false
    anchorWarning.value = ''
    errMsg.value = ''
    recognitionFailed.value = false
    retryable.value = false
    retrySubmitting.value = false
    confirmed.value = false
    correctionMode.value = false
    batchWorking.value = false
    confirming.value = false
    outcomeUnknown.value = false
    restoredFromBinding.value = false
    selectedSubject.value = ''
    currentDispatchId.value = ''
    currentDispatchVersion.value = 0
    currentTaskIntent.value = 'unknown'
    creativeProjection.value = null
    creativeConflicts.value = []
    creativeResult.value = null
    collapsed.value = false
    coldStarting.value = false
    coldStartResult.value = null
  },
)

// composer 改道图片：预填 + 自动识题（家长粘贴/上传即进护栏，无需再点「识题」）
watch(
  () => props.initialImage,
  (img) => {
    if (!img || !img.trim()) return
    collapsed.value = false
    imageB64.value = img
    void run()
  },
  { immediate: true },
)

// 刷新/重启恢复：没有新图片时，只按 session+agent 的最小绑定 GET 同一 dispatch。
// recovering 仅投影作业链的公开瞬时恢复进度；终态只从同一 facade result 读取。
onMounted(async () => {
  runtimeClock = setInterval(() => {
    runtimeNowSeconds.value = Math.floor(Date.now() / 1000)
  }, 1000)
  if (
    props.initialImage?.trim() ||
    !props.sessionId?.trim() ||
    !props.sourceMessageId?.trim() ||
    !props.restoreDispatchId?.trim()
  )
    return
  const generation = agentGeneration
  const controller = new AbortController()
  restoreAbort = controller
  restoredFromBinding.value = true
  try {
    const view = await store.restoreImageTaskDispatch(
      props.agentId,
      {
        sourceSession: props.sessionId,
        sourceMessageId: props.sourceMessageId,
        dispatchId: props.restoreDispatchId,
      },
      controller.signal,
      (snapshot) => {
        if (generation !== agentGeneration || controller.signal.aborted) return
        projectImageTaskDispatch(snapshot)
      },
    )
    if (generation !== agentGeneration || controller.signal.aborted) return
    if (!view) {
      restoredFromBinding.value = false
      emit('close')
      return
    }
    projectImageTaskView(view)
    if (view.stage === 'completed' || view.stage === 'feedback_ready') {
      batchWorking.value = true
      await completeImageTaskFlow()
      if (generation === agentGeneration && !controller.signal.aborted) batchWorking.value = false
    }
  } catch (error) {
    if (
      generation !== agentGeneration ||
      controller.signal.aborted ||
      (error as Error).name === 'AbortError'
    )
      return
    restoredFromBinding.value = false
    emit('close')
  } finally {
    if (restoreAbort === controller) restoreAbort = null
  }
})

async function run() {
  if (!imageB64.value.trim()) return
  restoreAbort?.abort()
  restoreAbort = null
  confirmationAbort?.abort()
  confirmationAbort = null
  confirming.value = false
  gradingAbort?.abort()
  gradingAbort = null
  const generation = agentGeneration
  const recognition = ++recognitionGeneration
  const sourceImage = imageB64.value.trim()
  // “最后一张图获胜”：换图只中止旧的本地轮询；服务端旧 dispatch 不被隐式取消。
  recognitionAbort?.abort()
  const controller = new AbortController()
  recognitionAbort = controller
  recognizing.value = true
  anchoring.value = false
  anchorWarning.value = ''
  errMsg.value = ''
  recognitionFailed.value = false
  outcomeUnknown.value = false
  restoredFromBinding.value = false
  annotatedImage.value = ''
  blankWorksheetGuide.value = []
  confirmed.value = false
  correctionMode.value = false
  coldStartResult.value = null
  currentDispatchId.value = ''
  currentDispatchVersion.value = 0
  currentTaskIntent.value = 'unknown'
  retryable.value = false
  retrySubmitting.value = false
  creativeProjection.value = null
  creativeConflicts.value = []
  creativeResult.value = null
  rows.value = []
  problemProgressSlots.value = []
  taskCoverage.value = null
  finalArtifact.value = null
  currentStructureVersion.value = 0
  selectedSubject.value = ''
  currentTaskStage.value = 'routing'
  automaticBudgetSeconds.value = undefined
  automaticStartedAt.value = undefined
  automaticDeadlineAt.value = undefined
  operationDeadlineAt.value = undefined
  syncExecutionState('routing')
  try {
    // 单入口先固化 Asset，再由 /image-tasks 分类；Desktop 不再创建或保存内部 Job identity。
    const task = await store.dispatchImageTask(
      {
        agent: props.agentId,
        dataUrl: sourceImage,
        sourceSession: props.sessionId ?? '',
        sourceRef: effectiveRequestId.value,
        messageIntent: props.messageIntent,
        route: props.modelRoute,
      },
      controller.signal,
      (snapshot) => {
        if (generation !== agentGeneration || recognition !== recognitionGeneration) return
        projectImageTaskDispatch(snapshot)
      },
    )
    if (generation !== agentGeneration || recognition !== recognitionGeneration) return
    projectImageTaskView(task)
    if (task.stage === 'recovering') {
      enterOutcomeUnknown(task.dispatchId)
      return
    }
    // Polish-2：识题自动判定整卷学科 → 预填学科下拉，家长不必手选（仍可手动覆盖）。
    // 仅识题判出学科时预填；一科都判不出则保持空，此时 solve/批改按钮仍 gate 空学科需家长手选。
    if (task.subject) selectedSubject.value = task.subject
    rows.value = guardRowsFromQuestions(task.questions)
    // Blank worksheet tasks have already frozen their source facts and completed
    // the whole-sheet parent guide. Read the same facade result directly; never
    // route this through the completed-homework confirmation/grade controls.
    if (task.stage === 'completed' || task.stage === 'feedback_ready') {
      confirmed.value = true
      batchWorking.value = true
      await completeImageTaskFlow()
      return
    }
    // Writing/artwork have their own CreativeWorkIntake lifecycle. They never
    // enter the homework anchor/recognition path; only the facade can advance
    // or expose their smallest confirmation conflict.
    if (task.taskIntent === 'writing' || task.taskIntent === 'artwork') return
    // 锚点与家长确认是正交分支。awaiting_confirmation 只代表识别事实已可回显，
    // 不能据此把 anchor_state=pending 当成最终无坐标；继续后台轮询，且只按稳定 ProblemID 补 geometry。
    if (task.anchorState === 'pending') {
      recognizing.value = false
      anchoring.value = true
      try {
        const anchored = await store.waitForImageTaskHomeworkAnchor(
          props.agentId,
          task.dispatchId,
          controller.signal,
        )
        if (generation !== agentGeneration || recognition !== recognitionGeneration) return
        if (anchored.stage === 'recovering') {
          enterOutcomeUnknown(task.dispatchId)
          return
        }
        for (const question of anchored.questions) {
          if (!question.problem_id) continue
          const row = rows.value.find((candidate) => candidate.problemId === question.problem_id)
          if (row && question.bbox) row.bbox = question.bbox
        }
        if (anchored.anchorState === 'degraded') {
          anchorWarning.value = t('k12.recognize.anchorFailed')
        }
      } catch (e) {
        if (
          generation !== agentGeneration ||
          recognition !== recognitionGeneration ||
          (e as Error).name === 'AbortError'
        )
          return
        // 定位分支失败只降级坐标，不污染已回显的识别事实，也不把整次识题误报为失败。
        anchorWarning.value = t('k12.recognize.anchorFailed')
      } finally {
        if (generation === agentGeneration && recognition === recognitionGeneration) {
          anchoring.value = false
        }
      }
    } else if (task.anchorState === 'degraded') {
      anchorWarning.value = t('k12.recognize.anchorFailed')
    }
  } catch (e) {
    if (
      generation !== agentGeneration ||
      recognition !== recognitionGeneration ||
      (e as Error).name === 'AbortError'
    )
      return
    errMsg.value = e instanceof Error ? e.message : String(e)
    recognitionFailed.value = true
    syncExecutionState(currentDispatchId.value ? 'recovering' : 'failed_retryable')
  } finally {
    if (generation === agentGeneration && recognition === recognitionGeneration) {
      recognizing.value = false
      if (recognitionAbort === controller) recognitionAbort = null
    }
  }
}

async function retryRecognitionStage() {
  if (
    outcomeUnknown.value ||
    recognizing.value ||
    retrySubmitting.value ||
    !retryable.value ||
    !currentDispatchId.value.trim() ||
    currentDispatchVersion.value < 1
  ) {
    return
  }
  const generation = agentGeneration
  const dispatchId = currentDispatchId.value
  errMsg.value = ''
  batchWorking.value = true
  retrySubmitting.value = true
  try {
    const view = await store.retryImageTask(props.agentId, dispatchId, currentDispatchVersion.value)
    if (generation !== agentGeneration || dispatchId !== currentDispatchId.value) return
    projectImageTaskView(view)
    if (view.stage === 'recovering') {
      enterOutcomeUnknown(dispatchId)
      return
    }
    await completeImageTaskFlow()
  } catch (error) {
    if (generation !== agentGeneration || (error as Error).name === 'AbortError') return
    recognitionFailed.value = true
    errMsg.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (generation === agentGeneration) retrySubmitting.value = false
    if (generation === agentGeneration && !outcomeUnknown.value) batchWorking.value = false
  }
}

function toggleEdit(row: GuardRow) {
  if (outcomeUnknown.value || confirming.value) return
  row.editing = !row.editing
  if (row.confirmationRequired) row.recognitionConfirmed = false
  confirmed.value = false
}

function startCorrection() {
  if (outcomeUnknown.value || confirming.value) return
  correctionMode.value = true
  for (const row of rows.value) row.editing = row.confirmationRequired
}

function gradingCorrections(): GradingQuestionCorrection[] {
  return rows.value.flatMap((row, index) =>
    row.confirmationRequired
      ? [
          {
            index,
            problem_id: row.problemId || undefined,
            confirmed: row.recognitionConfirmed,
            question: row.problem.trim(),
            canonical_markdown: row.problem.trim(),
            student_answer: row.studentAnswer.trim(),
            answer_canonical_markdown: row.studentAnswer.trim(),
            answer_state: row.answerState,
            subject: selectedSubject.value || undefined,
          },
        ]
      : [],
  )
}

function creativeFreezeCommand() {
  const projection = creativeProjection.value
  if (
    currentTaskIntent.value !== 'writing' ||
    projection?.status !== 'awaiting_confirmation' ||
    !projection.canonical_version ||
    !projection.canonical_content?.trim() ||
    !creativeConflicts.value.length
  ) {
    return null
  }

  let canonicalContent = projection.canonical_content.trim()
  const segmentCorrections: Array<{ segment_id: string; canonical_text: string }> = []
  for (const conflict of creativeConflicts.value) {
    const rawText = conflict.rawText.trim()
    const correctedText = conflict.editedText.trim()
    if (
      !conflict.segmentId.trim() ||
      !rawText ||
      !correctedText ||
      canonicalContent.split(rawText).length - 1 !== 1
    ) {
      return null
    }
    canonicalContent = canonicalContent.replace(rawText, correctedText)
    segmentCorrections.push({
      segment_id: conflict.segmentId,
      canonical_text: correctedText,
    })
  }
  return {
    action: 'freeze_ocr' as const,
    canonical_version: projection.canonical_version,
    canonical_content: canonicalContent,
    segment_corrections: segmentCorrections,
  }
}

const canConfirmCreative = computed(
  () =>
    !outcomeUnknown.value &&
    !confirming.value &&
    !!props.agentId.trim() &&
    !!currentDispatchId.value.trim() &&
    currentDispatchVersion.value > 0 &&
    unconfirmedCreativeConflictCount.value === 0 &&
    !!creativeFreezeCommand(),
)

function toggleCreativeConflictEdit(conflict: CreativeConflictRow) {
  if (outcomeUnknown.value || confirming.value) return
  conflict.editing = !conflict.editing
  conflict.confirmed = false
}

async function confirmCreativeOCR() {
  const creative = creativeFreezeCommand()
  if (!canConfirmCreative.value || !creative) return

  const generation = agentGeneration
  const dispatchId = currentDispatchId.value
  confirmationAbort?.abort()
  const controller = new AbortController()
  confirmationAbort = controller
  confirming.value = true
  errMsg.value = ''
  try {
    const view = await store.confirmImageTask(
      props.agentId,
      dispatchId,
      currentDispatchVersion.value,
      { creative },
      controller.signal,
    )
    if (
      generation !== agentGeneration ||
      controller.signal.aborted ||
      currentDispatchId.value !== dispatchId
    ) {
      return
    }
    projectImageTaskView(view)
    if (view.stage === 'recovering') {
      enterOutcomeUnknown(dispatchId)
      return
    }
    if (view.taskIntent !== 'writing' || view.stage === 'awaiting_confirmation') {
      throw new Error(t('k12.recognize.jobFailed'))
    }
    batchWorking.value = true
    await completeImageTaskFlow()
  } catch (error) {
    if (
      generation !== agentGeneration ||
      controller.signal.aborted ||
      (error as Error).name === 'AbortError'
    ) {
      return
    }
    errMsg.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (confirmationAbort === controller) confirmationAbort = null
    if (generation === agentGeneration) {
      confirming.value = false
      batchWorking.value = false
    }
  }
}

async function confirmAll() {
  if (
    outcomeUnknown.value ||
    confirming.value ||
    !props.agentId.trim() ||
    !props.sessionId?.trim() ||
    !currentDispatchId.value.trim() ||
    currentDispatchVersion.value < 1 ||
    !rows.value.length ||
    rows.value.some((row) => row.confirmationRequired && !row.problem.trim()) ||
    riskCount.value === 0 ||
    unconfirmedRiskCount.value > 0
  )
    return
  const generation = agentGeneration
  const dispatchId = currentDispatchId.value
  confirmationAbort?.abort()
  const controller = new AbortController()
  confirmationAbort = controller
  confirming.value = true
  errMsg.value = ''
  try {
    const view = await store.confirmImageTask(
      props.agentId,
      dispatchId,
      currentDispatchVersion.value,
      {
        subject: selectedSubject.value,
        grade: props.grade ?? '',
        corrections: gradingCorrections(),
      },
      controller.signal,
    )
    if (
      generation !== agentGeneration ||
      controller.signal.aborted ||
      currentDispatchId.value !== dispatchId
    )
      return
    projectImageTaskView(view)
    if (view.stage === 'recovering') {
      enterOutcomeUnknown(dispatchId)
    }
    if (view.stage !== 'recovering' && view.confirmationState !== 'confirmed') {
      throw new Error(t('k12.recognize.jobFailed'))
    }
    for (const row of rows.value) row.editing = false
    correctionMode.value = false
    confirmed.value = view.confirmationState === 'confirmed'
    // 确认只是同一个 dispatch 的停点，不是第二个用户任务。服务端确认成功后立即继续轮询
    // assessing→rendering→projecting，并在 completed 时自动展示结果。
    batchWorking.value = true
    await completeImageTaskFlow()
    if (generation === agentGeneration && !controller.signal.aborted) confirmed.value = true
  } catch (error) {
    if (
      generation !== agentGeneration ||
      controller.signal.aborted ||
      (error as Error).name === 'AbortError'
    )
      return
    errMsg.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (confirmationAbort === controller) confirmationAbort = null
    if (generation === agentGeneration) {
      confirming.value = false
      batchWorking.value = false
    }
  }
}

// ── INV-007：正确题默认折叠（口径对齐 IM 侧 INV-008 正确题单行摘要）────────────
// 批改结论 agree = 不需要家长关注 → 解法详情默认折叠为单行摘要（题号+✓+题干截断）；
// disagree/unverifiable 默认展开；solve 路径（graded=false）是家长主动求解，不折叠。
function hasCorrectSummary(row: GuardRow): boolean {
  return row.graded && row.verdict === 'agree'
}
function isDetailsCollapsed(row: GuardRow): boolean {
  return hasCorrectSummary(row) && !row.expanded
}
/** 摘要题干截断：rune 安全（Array.from），与 IM 侧「题干截断」同语义，长度取 UI 单行量级。 */
const CORRECT_SUMMARY_MAX = 32
function truncateProblem(problem: string): string {
  const chars = Array.from(problem.trim())
  if (chars.length <= CORRECT_SUMMARY_MAX) return problem.trim()
  return chars.slice(0, CORRECT_SUMMARY_MAX).join('') + '…'
}

onBeforeUnmount(() => {
  if (runtimeClock) {
    clearInterval(runtimeClock)
    runtimeClock = null
  }
  for (const controller of sourceActionControllers) controller.abort()
  sourceActionControllers.clear()
  pendingSourceProblemIds.value = new Set()
  recognitionGeneration += 1
  restoreAbort?.abort()
  restoreAbort = null
  confirmationAbort?.abort()
  confirmationAbort = null
  gradingAbort?.abort()
  gradingAbort = null
  recognitionAbort?.abort()
  recognitionAbort = null
})

/** Facade 化整卷批改：确认冻结后只轮询同一 dispatch，并从判别式 result 回填。 */
async function completeImageTaskFlow() {
  const generation = agentGeneration
  const dispatchId = currentDispatchId.value
  gradingAbort?.abort()
  const controller = new AbortController()
  gradingAbort = controller
  try {
    const outcome = await store.completeImageTask(
      props.agentId,
      dispatchId,
      {
        sourceSession: props.sessionId,
      },
      controller.signal,
      (status) => {
        if (generation !== agentGeneration || controller.signal.aborted) return
        projectImageTaskDispatch(status)
      },
    )
    if (generation !== agentGeneration || controller.signal.aborted) return
    outcomeUnknown.value = false
    if (outcome.stage === 'completed') {
      creativeResult.value = null
      applyPhotoJobResult(outcome.result)
    } else {
      // Creative result is a different discriminated projection. Never feed
      // intake/work metadata to the homework result mapper; feedback is only
      // rendered when the public result contract actually carries it.
      blankWorksheetGuide.value = []
      rows.value = []
      annotatedImage.value = ''
      creativeResult.value = {
        taskIntent: outcome.taskIntent,
        payload: outcome.result,
      }
      confirmed.value = true
    }
  } catch (error) {
    if (
      generation !== agentGeneration ||
      controller.signal.aborted ||
      (error as Error).name === 'AbortError'
    )
      return
    throw error
  } finally {
    if (gradingAbort === controller) gradingAbort = null
  }
}

/** Job completed 的逐题结果 → 护栏行状态（PhotoGradeOverlay 数据源对齐）。 */
function applyPhotoJobResult(result: PhotoJobResult) {
  const parentGuides = parentTeachingGuideItems(result)
  if (parentGuides.length) {
    // Preserve backend item order (the frozen original-question order), and
    // suppress the legacy recognition/grade controls for this separate surface.
    blankWorksheetGuide.value = parentGuides
    annotatedImage.value = ''
    rows.value = []
    confirmed.value = true
    return
  }
  blankWorksheetGuide.value = []
  if (
    result.task_intent !== 'completed_homework' ||
    result.result_surface !== 'annotated_homework' ||
    result.items.some(
      (item) =>
        (item.status === 'wrong' && !isParentTeachingGuide(item.parent_guide)) ||
        (item.status === 'correct' && item.parent_guide !== undefined),
    )
  ) {
    throw new Error('invalid completed homework result')
  }
  annotatedImage.value = annotatedImageDataURL(result.annotated_image)
  // 恢复 completed Job 时详情响应可能不再带 recognition 停点；结果中的稳定问题身份
  // 足以重建逐题视图，避免“任务完成但界面空白”。
  if (!rows.value.length && result.items.length) {
    rows.value = guardRowsFromQuestions(result.items.map((item) => item.question))
  }
  const answerableIndexes = rows.value
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isAnswerable(row))
    .map(({ index }) => index)
  result.items.forEach((item, resultIndex) => {
    const byID = item.question.problem_id
      ? rows.value.findIndex((row) => row.problemId === item.question.problem_id)
      : -1
    const row = rows.value[byID >= 0 ? byID : (answerableIndexes[resultIndex] ?? -1)]
    if (!row) return
    row.bbox = item.question.bbox ?? row.bbox
    const grade = item.grade
    switch (item.status) {
      case 'correct':
      case 'wrong':
      case 'out_of_scope':
      case 'untrusted': {
        if (!grade) break
        const res = gradeToResult(grade)
        row.verify = res.verify
        row.recorded = res.recordCreated
        row.recordDeduplicated = res.recordDeduplicated
        row.solution = res.solution
        row.wrongStep = res.wrongStep ?? ''
        row.errorCause = res.errorCause ?? ''
        row.parentGuide =
          item.status === 'wrong' && isParentTeachingGuide(item.parent_guide)
            ? item.parent_guide
            : null
        row.graded = true
        row.verdict = res.verdict
        // INV-007：整卷 Job 回填同样回到默认折叠态。
        row.expanded = false
        break
      }
      case 'blank_solved': {
        if (!grade) break
        // 解题分叉：无批改结论、不入库、不参与原图叠加。
        row.verify = gradeToVerify(grade)
        row.solution = grade.solution
        row.wrongStep = ''
        row.errorCause = ''
        row.parentGuide = null
        row.recorded = false
        row.recordDeduplicated = false
        row.graded = false
        row.verdict = ''
        break
      }
      default:
        // unanswered / answer_unclear / failed：保持行现状（既有空白/未读清提示继续生效）。
        break
    }
  })
}

async function coldStart() {
  if (outcomeUnknown.value || !canColdStart.value || coldStarting.value) return
  coldStarting.value = true
  errMsg.value = ''
  try {
    const resp = await store.coldStart({
      agent: props.agentId,
      knowledge_points: allKnowledgePoints.value,
    })
    coldStartResult.value = { grade: resp.grade_term, inferred: resp.inferred }
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    coldStarting.value = false
  }
}
</script>

<template>
  <div
    class="rec-panel"
    :class="{
      'rec-panel--conversation': !!initialImage || restoredFromBinding,
      'rec-panel--collapsed': collapsed,
    }"
    data-testid="recognize-guard"
    :data-source-message-id="sourceMessageId || undefined"
    :data-dispatch-id="currentDispatchId || restoreDispatchId || undefined"
  >
    <div class="rec-panel__head">
      <span v-if="!initialImage && !restoredFromBinding && !collapsed" class="rec-panel__title"
        >📷 {{ t('k12.recognize.title') }}</span
      >
      <span
        v-else-if="
          !collapsed && (currentTaskIntent === 'writing' || currentTaskIntent === 'artwork')
        "
        class="rec-panel__title"
        >{{ taskShellTitle }}</span
      >
      <template v-else-if="collapsed">
        <span class="rec-panel__title">{{ taskShellTitle }}</span>
        <span class="rec-panel__collapsed-summary">任务已收起 · 后台继续处理</span>
      </template>
      <button
        class="rec-panel__x"
        data-testid="recognize-close"
        :aria-label="collapsed ? '展开任务' : '收起任务'"
        :aria-expanded="collapsed ? 'false' : 'true'"
        :title="collapsed ? '展开任务' : '收起任务（后台继续处理）'"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? '↕' : '✕' }}
      </button>
    </div>
    <p v-if="!initialImage && !restoredFromBinding" class="rec-panel__intro">
      {{ t('k12.recognize.intro') }}
    </p>

    <!-- 图片输入：文件选择 + base64 粘贴回退 -->
    <label v-if="!initialImage && !restoredFromBinding" class="rec-panel__file">
      <input type="file" accept="image/*" data-testid="recognize-file" @change="onFile" />
      <span>{{ t('k12.recognize.pickImage') }}</span>
    </label>
    <!-- 选了图片 → 显示缩略图预览（不糊 base64 原文）；textarea 用 v-show 保留在 DOM 供粘贴回退。 -->
    <img
      v-if="isImageData && !initialImage && !restoredFromBinding"
      :src="imageB64"
      class="rec-panel__preview"
      data-testid="recognize-preview"
      alt="作业照片预览"
    />
    <HcClearableField v-if="!initialImage && !restoredFromBinding">
      <textarea
        v-show="!isImageData && !initialImage"
        v-model="imageB64"
        class="rec-panel__b64"
        data-testid="recognize-b64"
        :placeholder="t('k12.recognize.pasteHint')"
        rows="2"
      />
    </HcClearableField>

    <button
      v-if="!initialImage && !restoredFromBinding"
      class="rec-panel__run"
      data-testid="recognize-run"
      :disabled="!imageB64.trim() || recognizing"
      @click="run"
    >
      {{ recognizing ? t('k12.recognize.running') : t('k12.recognize.run') }}
    </button>

    <div
      v-if="
        errMsg &&
        !outcomeUnknown &&
        (!recognitionFailed || currentTaskIntent !== 'completed_homework')
      "
      class="rec-panel__err"
    >
      {{ t('k12.recognize.err') }}：{{ errMsg }}
    </div>

    <div
      v-if="recognizing && currentTaskIntent === 'unknown'"
      class="hc-typing-dots"
      data-testid="image-task-routing-progress"
      role="status"
      aria-label="正在识别"
    >
      <span class="hc-typing-dots__dot" />
      <span class="hc-typing-dots__dot" />
      <span class="hc-typing-dots__dot" />
    </div>

    <p
      v-if="
        currentTaskIntent === 'artwork' &&
        !creativeResult &&
        batchWorking &&
        !recognitionFailed &&
        !outcomeUnknown
      "
      class="rec-creative-progress"
      data-testid="artwork-feedback-progress"
      role="status"
    >
      <b>已识别出：美术作品</b>
      <span aria-hidden="true">···</span>
      <span>正在生成作品点评…</span>
    </p>

    <p
      v-if="
        currentTaskIntent === 'writing' &&
        !creativeResult &&
        batchWorking &&
        !recognitionFailed &&
        !outcomeUnknown
      "
      class="rec-creative-progress"
      data-testid="writing-feedback-progress"
      role="status"
    >
      <span>正在生成作品点评…</span>
    </p>

    <TaskProgressCard
      v-if="homeworkTaskProgressState"
      :state="homeworkTaskProgressState"
      :summary="homeworkTaskSummary"
      :ariaLabel="'已作答作业处理状态'"
      :items="homeworkTimelineItems"
      @view-result="viewHomeworkResult"
    />
    <div
      v-if="homeworkTaskProgressState === 'completed'"
      ref="homeworkResultAnchor"
      class="rec-panel__result-anchor"
      data-testid="homework-results-anchor"
      tabindex="-1"
    />

    <div
      v-if="
        outcomeUnknown ||
        (!hasBlankWorksheetGuide &&
          !showOverlay &&
          ((currentTaskIntent === 'completed_homework' &&
            (rows.length || recognitionFailed || recognizing || batchWorking || anchoring)) ||
            ((currentTaskIntent === 'writing' || currentTaskIntent === 'artwork') &&
              recognitionFailed)))
      "
      class="rec-pipeline"
      data-testid="recognize-pipeline"
      aria-label="已作答作业处理状态"
    >
      <div
        v-if="
          !homeworkTaskProgressState &&
          !outcomeUnknown &&
          currentTaskIntent === 'completed_homework'
        "
        class="rec-pipeline__head"
      >
        <b>已作答作业</b>
        <span>{{
          riskCount ? `清晰内容自动处理 · 仅核对 ${riskCount} 处不确定项` : '清晰内容自动处理'
        }}</span>
      </div>
      <ol
        v-if="
          !outcomeUnknown &&
          currentTaskIntent === 'completed_homework' &&
          problemProgressSlots.length
        "
        class="rec-problem-progress"
        role="list"
        aria-label="逐题处理进度"
      >
        <li
          v-for="item in problemProgressItems"
          :key="item.key"
          class="rec-problem-progress__item"
          role="listitem"
          :data-problem-id="item.kind === 'problem' ? item.problem.problem_id : undefined"
          :data-problem-group-id="item.kind === 'group' ? item.groupId : undefined"
        >
          <template v-if="item.kind === 'problem'">
            <div class="rec-problem-progress__line">
              <b>{{ problemProgressDisplayLabel(item.problem) }}</b>
              <span>{{ problemProgressStatus(item.problem) }}</span>
            </div>
            <SourceIssueResolver
              v-if="problemNeedsResolver(item.problem)"
              scope="problem"
              :display-label="problemProgressDisplayLabel(item.problem)"
              :affected-labels="[problemProgressDisplayLabel(item.problem)]"
              :problem-ids="[item.problem.problem_id]"
              :structure-version="currentStructureVersion"
              :expected-input-revision="expectedInputRevision([item.problem])"
              :skipped="problemIsSkipped(item.problem)"
              :command-available="!resolverDisabled([item.problem])"
              skip-label="跳过这题"
              @intent="applyLocalSourceIntent"
            />
          </template>
          <template v-else>
            <div class="rec-problem-progress__line">
              <b>{{ item.displayLabel }}</b>
              <span>公共题干 · {{ item.problems.length }} 个小题</span>
            </div>
            <div
              v-for="problem in item.problems"
              :key="problem.problem_id"
              class="rec-problem-progress__child"
              :data-problem-id="problem.problem_id"
            >
              <span>{{ problemProgressDisplayLabel(problem) }}</span>
              <span>{{ problemProgressStatus(problem) }}</span>
            </div>
            <SourceIssueResolver
              v-if="item.problems.some(problemNeedsResolver)"
              scope="group"
              :display-label="item.displayLabel"
              :affected-labels="item.problems.map(problemProgressDisplayLabel)"
              :problem-ids="item.problems.map((problem) => problem.problem_id)"
              :dependency-group-id="item.groupId"
              :structure-version="currentStructureVersion"
              :expected-input-revision="expectedInputRevision(item.problems)"
              :skipped="item.problems.every(problemIsSkipped)"
              :command-available="!resolverDisabled(item.problems)"
              :skip-label="`跳过第 ${item.ordinal} 题组`"
              @intent="applyLocalSourceIntent"
            />
          </template>
        </li>
      </ol>
      <div
        v-if="
          !homeworkTaskProgressState &&
          !outcomeUnknown &&
          currentTaskIntent === 'completed_homework'
        "
        class="rec-pipeline__branches"
      >
        <div class="rec-pipeline__branch is-done" data-testid="recognize-confirm-branch">
          <i>✓</i>
          <div>
            <b>清晰题已自动通过</b>
            <small>识别证据一致，不需要家长逐题确认</small>
          </div>
        </div>
        <div
          class="rec-pipeline__branch"
          :class="{
            'is-done': rows.length && !anchoring && !anchorWarning,
            'is-degraded': !!anchorWarning,
          }"
          data-testid="recognize-anchor-branch"
        >
          <i>{{ anchorWarning ? '!' : rows.length && !anchoring ? '✓' : '2' }}</i>
          <div>
            <b>
              <span
                v-if="!anchorWarning && !(rows.length && !anchoring)"
                class="hc-typing-dots hc-typing-dots--inline"
                aria-label="处理中"
                role="status"
              >
                <span class="hc-typing-dots__dot"></span>
                <span class="hc-typing-dots__dot"></span>
                <span class="hc-typing-dots__dot"></span>
              </span>
              {{
                anchorWarning
                  ? '定位超时 · 已转文字批改'
                  : rows.length && !anchoring
                    ? '原图题目已定位'
                    : '正在定位原图题目'
              }}
            </b>
            <small>{{
              anchorWarning ||
              (rows.length && !anchoring
                ? '坐标只补充展示，不改写已冻结文字'
                : activeStageTimingText)
            }}</small>
          </div>
        </div>
      </div>
      <div
        v-if="recognitionFailed && !outcomeUnknown"
        class="rec-pipeline__error"
        data-testid="recognize-stage-error"
        role="alert"
      >
        <span>{{ t('k12.recognize.err') }}：{{ errMsg }}</span>
        <span v-if="!retryable" data-testid="recognize-stage-not-retryable"
          >当前状态不能安全重试，系统不会重复提交。</span
        >
        <span v-if="retrySubmitting" data-testid="recognize-retry-processing" role="status"
          >正在处理同一个任务…</span
        >
      </div>
      <div
        v-if="outcomeUnknown"
        class="rec-pipeline__error is-unknown"
        data-testid="recognize-recovering"
        role="status"
      >
        <span
          ><b>正在恢复批改结果</b
          >系统正在查询同一个任务的服务端状态；不会重新创建任务或重复提交。恢复后会自动显示结果。</span
        >
      </div>
    </div>

    <section
      v-if="finalArtifact && finalArtifactID && finalArtifactDigest"
      class="rec-final-artifact"
      data-testid="image-task-final-artifact"
      :data-artifact-id="finalArtifactID"
      :data-artifact-digest="finalArtifactDigest"
      aria-label="批改最终结果"
    >
      <b>{{ isWithSkips ? '处理完成 · 有跳过' : '处理完成' }}</b>
      <h3>{{ finalArtifactTitle }}</h3>
      <p v-if="taskCoverage">
        共 {{ taskCoverage.total }} 题 · 已处理 {{ taskCoverage.processed }} 题 ·
        {{ taskCoverage.skipped }} 题由家长跳过
      </p>
      <div v-if="skippedProblems.length" class="rec-final-artifact__skips">
        <div
          v-for="problem in skippedProblems"
          :key="problem.problem_id"
          :data-problem-id="problem.problem_id"
        >
          <span>{{ problemProgressDisplayLabel(problem) }}</span>
          <span>已跳过 · 未判断对错</span>
        </div>
      </div>
      <p v-if="isWithSkips">本次有 {{ taskCoverage?.skipped ?? 0 }} 题跳过，未生成完整辅导要点。</p>
      <FinalArtifactActions
        :artifact-id="finalArtifactID"
        :artifact-digest="finalArtifactDigest"
        :artifact-title="finalArtifactTitle"
        @intent="emit('finalArtifactAction', $event)"
      />
    </section>

    <div
      v-show="!hasBlankWorksheetGuide && !showOverlay && rows.length && !selectedSubject"
      class="rec-panel__subject"
      data-testid="recognize-subject"
    >
      <span>{{ t('k12.accum.subject') }}</span>
      <HcSelect
        v-model="selectedSubject"
        :options="subjectOptions"
        :placeholder="t('k12.tutoringTips.pickHint')"
      />
    </div>

    <div
      v-if="creativeResult"
      class="rec-creative-result"
      :data-testid="`${creativeResult.taskIntent}-result-surface`"
      :data-task-intent="creativeResult.taskIntent"
      :data-result-surface="
        creativeResult.taskIntent === 'writing' ? 'writing-feedback' : 'art-feedback'
      "
      :data-intake-status="creativeResult.payload.intake.status"
      :data-work-id="creativeResult.payload.work?.work_id || undefined"
    >
      <CreativeWorkFeedbackRenderer
        v-if="creativeResult.payload.feedback"
        :data-testid="`${creativeResult.taskIntent}-result-feedback`"
        :generation-id="creativeResult.payload.feedback.generation_id"
        :feedback-id="creativeResult.payload.feedback.structured_feedback.feedback_id"
        :projection-markdown="creativeResult.payload.feedback.projection_markdown"
        :visible-evidence="
          creativeResult.payload.feedback.structured_feedback.observations.map(
            (observation) => observation.evidence,
          )
        "
        :affirmation="creativeResult.payload.feedback.structured_feedback.suggestions[0] || ''"
        :parent-guidance="creativeResult.payload.feedback.structured_feedback.suggestions[1] || ''"
        :next-step="creativeResult.payload.feedback.structured_feedback.suggestions[2] || ''"
        :limitations="creativeResult.payload.feedback.structured_feedback.limitations"
      />
    </div>

    <!-- 冷启动倒查建档入口（#3，仅无年级 + 已识题时） -->
    <div v-if="!hasBlankWorksheetGuide && !showOverlay && canColdStart" class="rec-cold">
      <span class="rec-cold__hint">{{ t('k12.recognize.coldStartHint') }}</span>
      <button
        class="rec-cold__btn"
        data-testid="coldstart-infer"
        :disabled="outcomeUnknown || coldStarting"
        @click="coldStart"
      >
        {{
          coldStarting ? t('k12.recognize.coldStartInferring') : t('k12.recognize.coldStartInfer')
        }}
      </button>
    </div>
    <div
      v-if="!hasBlankWorksheetGuide && !showOverlay && coldStartResult"
      class="rec-cold rec-cold--done"
      data-testid="coldstart-result"
    >
      {{
        coldStartResult.inferred
          ? t('k12.recognize.coldStartInferred', { grade: coldStartResult.grade })
          : t('k12.recognize.coldStartFallback', { grade: coldStartResult.grade })
      }}
    </div>

    <!-- 空白卷使用独立的家长讲题结果面。 -->
    <section
      v-if="hasBlankWorksheetGuide"
      class="guide blank-worksheet-guide"
      data-testid="blank-worksheet-parent-guide"
      aria-label="空白卷家长讲题指南"
    >
      <div class="guide__head">
        <b>📋 空白卷 · 家长讲题指南</b>
        <span class="guide__unit">已按原题顺序自动解答 {{ blankWorksheetGuide.length }} 题</span>
      </div>
      <div class="guide__body">
        <details
          v-for="(item, index) in blankWorksheetGuide"
          :key="item.problemId || `${index}-${item.question}`"
          open
          class="grade-card grade-card--issue"
          data-testid="blank-worksheet-guide-item"
          :data-parent-guide-problem="index + 1"
        >
          <summary>
            <span class="grade-card__status">{{ index + 1 }}</span>
            <MarkdownRenderer class="grade-card__question" :content="item.question" />
          </summary>
          <div class="grade-card__body">
            <div class="grade-card__row">
              <span>答案</span
              ><MarkdownRenderer class="grade-card__md" :content="item.guide.answer" />
            </div>
            <div class="grade-card__row">
              <span>必要步骤</span>
              <ol class="grade-card__list">
                <li v-for="step in item.guide.full_solution_steps" :key="step">
                  <MarkdownRenderer class="grade-card__md" :content="step" />
                </li>
              </ol>
            </div>
            <div class="grade-card__row">
              <span>本年级方法</span
              ><MarkdownRenderer class="grade-card__md" :content="item.guide.grade_level_method" />
            </div>
            <div class="grade-card__row">
              <span>易错点</span>
              <ul class="grade-card__list">
                <li v-for="mistake in item.guide.likely_mistakes" :key="mistake">
                  <MarkdownRenderer class="grade-card__md" :content="mistake" />
                </li>
              </ul>
            </div>
            <div class="grade-card__row">
              <span>家长怎么讲</span>
              <ol class="grade-card__list">
                <li v-for="step in item.guide.parent_teaching_sequence" :key="step">
                  <MarkdownRenderer class="grade-card__md" :content="step" />
                </li>
              </ol>
            </div>
            <div class="grade-card__row">
              <span>可以追问</span>
              <ul class="grade-card__list">
                <li v-for="question in item.guide.follow_up_questions" :key="question">
                  <MarkdownRenderer class="grade-card__md" :content="question" />
                </li>
              </ul>
            </div>
            <div class="grade-card__row">
              <span>怎么检查</span
              ><MarkdownRenderer class="grade-card__md" :content="item.guide.checking_method" />
            </div>
          </div>
        </details>
      </div>
    </section>

    <div
      v-else-if="
        currentTaskIntent === 'writing' &&
        creativeProjection?.status === 'awaiting_confirmation' &&
        creativeConflicts.length
      "
      class="rec-guard"
      data-testid="creative-conflict-guard"
    >
      <div
        v-for="conflict in creativeConflicts"
        :key="conflict.segmentId"
        class="rec-row"
        data-testid="creative-conflict-item"
        :data-segment-id="conflict.segmentId"
      >
        <div class="rec-row__q">
          <HcClearableField v-if="conflict.editing">
            <input
              v-model="conflict.editedText"
              class="rec-row__edit"
              data-testid="creative-conflict-input"
              :disabled="confirming"
            />
          </HcClearableField>
          <span v-else class="rec-row__qtext">{{ conflict.editedText }}</span>
          <button
            class="rec-row__toggle"
            data-testid="creative-conflict-edit"
            :disabled="confirming"
            @click="toggleCreativeConflictEdit(conflict)"
          >
            {{ conflict.editing ? t('k12.recognize.readOk') : t('k12.recognize.readWrong') }}
          </button>
        </div>
        <div class="rec-row__risk">
          <span>请对照原图核对</span>
          <label class="rec-row__risk-check">
            <input
              v-model="conflict.confirmed"
              type="checkbox"
              data-testid="creative-conflict-confirm"
              :disabled="confirming"
            />
            我已逐项核对
          </label>
        </div>
      </div>
      <p
        v-if="unconfirmedCreativeConflictCount"
        class="rec-guard__confidence-note"
        data-testid="creative-conflict-count"
      >
        还有 {{ unconfirmedCreativeConflictCount }} 处高风险识别需要逐项对照原图确认。
      </p>
      <div class="rec-guard__confirm-actions">
        <button
          class="rec-guard__confirm"
          data-testid="creative-confirm-all"
          :disabled="!canConfirmCreative"
          @click="confirmCreativeOCR"
        >
          {{ t('k12.recognize.confirmAll') }}
        </button>
      </div>
    </div>

    <!-- 已作答作业终态只投影一个结果面：批注原图与摘要在前，错题家长讲法和正确题折叠均内聚其中。 -->
    <PhotoGradeOverlay
      v-else-if="currentTaskIntent === 'completed_homework' && showOverlay"
      :image="imageB64"
      :annotated-image="annotatedImage"
      :marks="overlayMarks"
    />

    <div v-else-if="currentTaskIntent === 'completed_homework' && rows.length" class="rec-guard">
      <p v-if="!confirmed && riskCount" class="rec-guard__lead">
        📷 {{ t('k12.recognize.confirmLead') }}
      </p>
      <div
        v-for="(row, i) in rows"
        :key="row.problemId || i"
        class="rec-row"
        :class="{
          'rec-row--parent': row.problemKind === 'compound_parent',
          'rec-row--child': row.problemKind === 'subproblem',
        }"
        data-testid="rq-item"
        :data-problem-id="row.problemId"
        :data-parent-problem-id="row.parentProblemId"
        :data-problem-kind="row.problemKind"
      >
        <div class="rec-row__q">
          <HcClearableField v-if="row.editing">
            <input
              v-model="row.problem"
              class="rec-row__edit"
              :data-testid="`rq-problem-${i}`"
              :placeholder="t('k12.recognize.problemPlaceholder')"
              :disabled="confirming"
            />
          </HcClearableField>
          <MarkdownRenderer
            v-else
            class="rec-row__qtext"
            :data-testid="row.problemKind === 'compound_parent' ? 'rq-parent' : undefined"
            :content="`**${rowLabel(row, i)}.** ${row.problem}`"
          />
          <button
            v-if="correctionMode && row.confirmationRequired"
            class="rec-row__toggle"
            :data-testid="`rq-edit-${i}`"
            @click="toggleEdit(row)"
          >
            {{ row.editing ? t('k12.recognize.readOk') : t('k12.recognize.readWrong') }}
          </button>
        </div>
        <div
          v-if="!confirmed && row.confirmationRequired"
          class="rec-row__risk"
          :data-testid="`rq-risk-${i}`"
        >
          <span>请对照原图核对：{{ row.confirmationReasons.map(riskLabel).join('、') }}</span>
          <label class="rec-row__risk-check">
            <input
              v-model="row.recognitionConfirmed"
              type="checkbox"
              :data-testid="`rq-confirm-${i}`"
            />
            我已逐项核对
          </label>
        </div>
        <div v-show="confirmed && row.knowledgePoints.length" class="rec-row__kp">
          {{ t('k12.recognize.kpLabel') }}：<span
            v-for="kp in row.knowledgePoints"
            :key="kp"
            class="rec-row__kpchip"
            >{{ kp }}</span
          >
        </div>

        <VerifyBadge v-if="row.verify" :result="row.verify" />
        <!-- INV-007：正确题（verdict=agree）默认折叠为单行摘要（题号+✓+题干截断），
             点击展开完整解法；徽章（信任链证据）保持可见不折叠。 -->
        <button
          v-if="hasCorrectSummary(row)"
          class="rec-row__correct-summary"
          :data-testid="`rq-correct-summary-${i}`"
          :aria-expanded="row.expanded ? 'true' : 'false'"
          @click="row.expanded = !row.expanded"
        >
          <span class="rec-row__correct-line"
            >{{ i + 1 }}. ✓ {{ truncateProblem(row.problem) }}</span
          >
          <span class="rec-row__correct-toggle">{{
            row.expanded ? t('k12.recognize.correctCollapse') : t('k12.recognize.correctExpand')
          }}</span>
        </button>
        <div
          v-if="
            row.verify &&
            (row.solution || row.wrongStep || row.errorCause) &&
            !isDetailsCollapsed(row)
          "
          class="rec-row__details"
          :data-testid="`rq-grade-details-${i}`"
        >
          <!-- 解答/批改讲评/错因为模型生成的富文本（含公式/列表）→ 标签保留、值走 md 渲染。 -->
          <div v-if="row.solution">
            <b>{{ t('k12.recognize.solution') }}：</b
            ><MarkdownRenderer class="rec-row__md" :content="row.solution" />
          </div>
          <div v-if="row.wrongStep">
            <b>{{ t('k12.recognize.wrongStep') }}：</b
            ><MarkdownRenderer class="rec-row__md" :content="row.wrongStep" />
          </div>
          <div v-if="row.errorCause">
            <b>{{ t('k12.recognize.errorCause') }}：</b
            ><MarkdownRenderer class="rec-row__md" :content="row.errorCause" />
          </div>
        </div>
        <div v-if="row.verify && row.recorded" class="rec-row__recorded">
          🗂 {{ t('k12.recognize.recorded') }}
          <span v-if="row.recordDeduplicated" :data-testid="`rq-record-deduplicated-${i}`">
            · {{ t('k12.recognize.recordDeduplicated') }}</span
          >
        </div>
      </div>
      <p
        v-if="!confirmed && unclearAnswerCount"
        class="rec-guard__confidence-note"
        data-testid="recognize-confidence-note"
      >
        <span>{{ t('k12.recognize.needsConfirm') }}</span>
        {{ t('k12.recognize.unclearRecognitionNote', { count: unclearAnswerCount }) }}
      </p>
      <p
        v-if="!confirmed && unconfirmedRiskCount"
        class="rec-guard__confidence-note"
        data-testid="recognize-risk-count"
      >
        还有 {{ unconfirmedRiskCount }} 处高风险识别需要逐项对照原图确认。
      </p>
      <div v-if="!confirmed && riskCount" class="rec-guard__confirm-actions">
        <button
          class="rec-guard__confirm"
          data-testid="recognize-confirm-all"
          :disabled="
            outcomeUnknown ||
            confirming ||
            !agentId.trim() ||
            !sessionId?.trim() ||
            !currentDispatchId.trim() ||
            currentDispatchVersion < 1 ||
            rows.some((row) => !row.problem.trim()) ||
            unconfirmedRiskCount > 0
          "
          @click="confirmAll"
        >
          {{ t('k12.recognize.confirmAll') }}
        </button>
        <button
          v-if="!correctionMode"
          class="rec-guard__correct"
          data-testid="recognize-correct"
          :disabled="outcomeUnknown || confirming"
          @click="startCorrection"
        >
          {{ t('k12.recognize.correctRecognition') }}
        </button>
      </div>
    </div>
    <p
      v-else-if="
        !hasBlankWorksheetGuide &&
        currentTaskIntent !== 'writing' &&
        currentTaskIntent !== 'artwork' &&
        !recognizing &&
        !outcomeUnknown &&
        !restoredFromBinding
      "
      class="rec-panel__empty"
    >
      {{ t('k12.recognize.empty') }}
    </p>

    <!-- 服务端持久确认成功后才内联辅导要点；未知结果只冻结生成，不清空已生成内容。 -->
    <TutoringTipsPanel
      v-if="
        !hasBlankWorksheetGuide &&
        !taskCoverage &&
        confirmed &&
        selectedSubject &&
        rows.length &&
        allKnowledgePoints.length
      "
      :agent-id="agentId"
      :dispatch-id="currentDispatchId"
      :session-id="sessionId"
      :generation-locked="outcomeUnknown"
      :grade="props.grade || ''"
      :subject="selectedSubject"
      :textbook="activeTextbook"
      :knowledge-points="allKnowledgePoints"
    />
    <MessageFooter
      v-if="showTaskFooter"
      class="rec-panel__footer msg-footer"
      data-testid="task-shell-footer"
    >
      <div class="rec-panel__metadata msg-meta" data-testid="task-shell-metadata">
        <template
          v-for="(part, index) in [
            taskTimeDisplay,
            taskProviderDisplayName,
            taskModelDisplayName,
            agentDisplayName,
            grade,
          ].filter(Boolean)"
          :key="`${index}:${part}`"
        >
          <span v-if="index">·</span>
          <span>{{ part }}</span>
        </template>
      </div>
      <MessageActions
        role="assistant"
        :content="taskShellTitle"
        :show-retry="showTaskRetry"
        @retry="retryRecognitionStage"
      />
    </MessageFooter>
  </div>
</template>

<style scoped>
.rec-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}
.rec-panel--conversation {
  padding: 10px 14px 12px;
}
.rec-panel--collapsed > :not(.rec-panel__head):not(.rec-panel__footer) {
  display: none !important;
}
.rec-panel--collapsed.rec-panel--conversation {
  padding: 10px 12px;
}
.rec-panel--conversation .rec-panel__head {
  position: absolute;
  z-index: 1;
  top: 5px;
  right: 5px;
}
.rec-panel--collapsed.rec-panel--conversation .rec-panel__head {
  position: static;
  width: 100%;
  gap: 8px;
}
.rec-panel--conversation .rec-panel__x {
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background 0.15s ease;
}
.rec-panel--collapsed.rec-panel--conversation .rec-panel__x {
  opacity: 1;
}
.rec-panel--conversation:hover .rec-panel__x,
.rec-panel--conversation .rec-panel__x:focus-visible {
  opacity: 1;
}
/* K12-INV-060: a blank worksheet has its own approved parent-teaching result
   surface. These are the same guide/grade-card primitives as the prototype;
   they deliberately do not inherit completed-homework assessment styling. */
.guide {
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--hc-border-hl);
  border-radius: 14px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
}
.guide__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 15px;
  border-bottom: 0.5px solid var(--hc-divider);
  background: var(--hc-accent-subtle);
}
.guide__head b {
  font-size: 13px;
  font-weight: 700;
}
.guide__unit {
  padding: 2px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.guide__body {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 13px 15px;
}
.grade-card {
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--hc-border);
  border-radius: 11px;
  background: var(--hc-bg-card);
  transition:
    border-color 0.18s,
    box-shadow 0.18s;
}
.grade-card[open] {
  border-color: color-mix(in srgb, var(--hc-warning) 45%, var(--hc-border));
  box-shadow: var(--hc-shadow-sm);
}
.grade-card summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 11px;
  list-style: none;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 700;
}
.grade-card summary::-webkit-details-marker {
  display: none;
}
.grade-card summary::after {
  margin-left: auto;
  color: var(--hc-text-muted);
  content: '⌄';
  transition: transform 0.15s;
}
.grade-card[open] summary::after {
  transform: rotate(180deg);
}
.grade-card__status {
  display: grid;
  flex: none;
  width: 23px;
  height: 23px;
  place-items: center;
  border-radius: 50%;
  background: var(--hc-accent);
  color: #fff;
  font-weight: 900;
}
.grade-card__question {
  min-width: 0;
  color: var(--hc-text-primary);
}
.grade-card__question :deep(p),
.grade-card__md :deep(p) {
  margin: 0;
}
.grade-card__body {
  padding: 0 11px 11px;
  border-top: 1px solid var(--hc-divider);
}
.grade-card__row {
  display: grid;
  grid-template-columns: 66px minmax(0, 1fr);
  gap: 7px;
  padding-top: 8px;
  color: var(--hc-text-secondary);
  font-size: 10.5px;
  line-height: 1.55;
}
.grade-card__row > span:first-child {
  color: var(--hc-text-muted);
}
.grade-card__list {
  display: grid;
  gap: 3px;
  margin: 0;
  padding-left: 18px;
}
.rec-panel__head {
  display: flex;
  align-items: center;
}
.rec-panel__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding-top: 7px;
}
.rec-panel__metadata {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  color: var(--hc-text-muted);
  font-size: 10.5px;
  line-height: 1.4;
  white-space: nowrap;
}
.rec-panel__title {
  font-size: 13px;
  font-weight: 700;
  flex: 1;
}
.rec-panel__collapsed-summary {
  color: var(--hc-text-muted);
  font-size: 11.5px;
}
.rec-panel__x {
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 6px;
  flex-shrink: 0;
}
.rec-panel__x:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.rec-panel__intro {
  font-size: 12px;
  color: var(--hc-text-muted);
  line-height: 1.5;
  margin: 0;
}
.rec-creative-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.rec-creative-progress b {
  color: var(--hc-text-primary);
}
.rec-panel__file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
  padding: 6px 10px;
  border: 0.5px dashed var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
}
.rec-panel__file input {
  font-size: 11px;
}
.rec-panel__b64 {
  width: 100%;
  box-sizing: border-box;
  font-size: 11px;
  padding: 6px 8px;
  resize: vertical;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
}
/* BUG-20260712：作业照片缩略图预览（替代把 base64 原文糊在框里）。 */
.rec-panel__preview {
  max-width: 100%;
  max-height: 180px;
  object-fit: contain;
  border-radius: var(--hc-radius-md);
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  align-self: flex-start;
}
.rec-panel__run {
  font-size: 12.5px;
  padding: 8px;
  border: 0.5px solid var(--hc-border-hl);
  border-radius: var(--hc-radius-md);
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  cursor: pointer;
}
.rec-panel__run:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rec-panel__err {
  font-size: 12px;
  color: var(--hc-danger, #e05a5a);
}
.rec-pipeline {
  margin: 9px 0 8px;
  padding: 10px;
  border: 1px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-input);
}
.rec-pipeline__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
  color: var(--hc-text-muted);
  font-size: 11px;
}
.rec-pipeline__head b {
  color: var(--hc-text-primary);
  font-size: 11.5px;
}
.rec-problem-progress {
  display: grid;
  gap: 7px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}
.rec-problem-progress__item {
  padding: 8px 9px;
  border-radius: 9px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  font-size: 10.5px;
  font-weight: 600;
}
.rec-pipeline__branches {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.rec-pipeline__branch {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 9px;
  border-radius: 9px;
  background: var(--hc-bg-card);
  color: var(--hc-text-muted);
  font-size: 10.5px;
  line-height: 1.45;
}
.rec-pipeline__branch > i {
  display: grid;
  place-items: center;
  flex: none;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-style: normal;
  font-weight: 800;
}
.rec-pipeline__branch b {
  display: block;
  color: var(--hc-text-primary);
  font-size: 10.5px;
}
.rec-pipeline__branch small {
  display: block;
  margin-top: 2px;
  line-height: 1.4;
}
.rec-pipeline__branch.is-done > i {
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
  color: var(--hc-success);
}
.rec-pipeline__branch.is-degraded > i {
  background: color-mix(in srgb, var(--hc-warning) 14%, transparent);
  color: var(--hc-warning);
}
.rec-pipeline__error {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  padding: 8px 9px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--hc-error) 7%, transparent);
  color: var(--hc-error);
  font-size: 10.5px;
}
.rec-pipeline__error span {
  flex: 1;
}
.rec-pipeline__error button {
  padding: 3px 7px;
  border: 0.5px solid currentColor;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.rec-pipeline__error.is-unknown {
  align-items: flex-start;
  background: color-mix(in srgb, var(--hc-warning) 10%, transparent);
  color: var(--hc-text-secondary);
}
.rec-pipeline__error.is-unknown span {
  line-height: 1.5;
}
.rec-pipeline__error.is-unknown b {
  display: block;
  margin-bottom: 1px;
  color: var(--hc-warning);
  font-size: 10.5px;
}
.rec-panel__subject {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-width: 260px;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}
.rec-row__details {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-elevated);
  border-inline-start: 3px solid var(--hc-accent);
  border-start-end-radius: var(--hc-radius-sm);
  border-end-end-radius: var(--hc-radius-sm);
}
.rec-row__details b {
  color: var(--hc-text-primary);
}

/* md 值容器:紧凑段距，避免块级 p 默认外边距撑开批改详情行。 */
.rec-row__md :deep(p) {
  margin: 2px 0;
}
.rec-row__md :deep(p:first-child) {
  margin-top: 0;
}
.rec-row__md :deep(p:last-child) {
  margin-bottom: 0;
}
.rec-panel__empty {
  font-size: 12px;
  color: var(--hc-text-muted);
  text-align: center;
  padding: 8px;
  margin: 0;
}
/* 冷启动倒查建档 */
.rec-cold {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-inline-start: 3px solid var(--hc-warn, #e0a03a);
  background: var(--hc-bg-elevated);
  border-start-end-radius: var(--hc-radius-md);
  border-end-end-radius: var(--hc-radius-md);
}
.rec-cold__hint {
  font-size: 12px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
}
.rec-cold__btn {
  align-self: flex-start;
  font-size: 12px;
  padding: 6px 12px;
  border: 0.5px solid var(--hc-border-hl);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  cursor: pointer;
}
.rec-cold--done {
  border-inline-start-color: var(--hc-success);
  font-size: 12px;
  color: var(--hc-text-primary);
}
/* 识题回显护栏 */
.rec-guard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.rec-guard__lead {
  margin: 0 0 4px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--hc-text-primary);
}
.rec-guard__lead--confirmed {
  font-weight: 600;
}
.rec-guard__confirm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rec-guard__confidence-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--hc-text-muted);
}
.rec-guard__confidence-note span {
  display: inline-flex;
  margin-right: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hc-warning) 14%, transparent);
  color: var(--hc-warning);
}
.rec-guard__confirm {
  font-size: 12px;
  padding: 7px 14px;
  border: 0.5px solid var(--hc-border-hl);
  border-radius: var(--hc-radius-md);
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  cursor: pointer;
}
.rec-guard__confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rec-guard__correct {
  font-size: 12px;
  padding: 7px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  cursor: pointer;
}
.rec-row {
  border-inline-start: 3px solid var(--hc-accent);
  padding: 8px 10px;
  background: var(--hc-bg-elevated);
  border-start-end-radius: var(--hc-radius-md);
  border-end-end-radius: var(--hc-radius-md);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rec-row--parent {
  border-inline-start-color: var(--hc-text-muted);
  background: var(--hc-bg-subtle);
  font-weight: 600;
}
.rec-row--child {
  margin-inline-start: 16px;
  border-inline-start-width: 2px;
}
.rec-row__risk {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--hc-radius-md);
  background: color-mix(in srgb, var(--hc-warning) 10%, transparent);
  color: var(--hc-warning);
  font-size: 11.5px;
  font-weight: 400;
}
.rec-row__risk-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  cursor: pointer;
}
.rec-panel--conversation .rec-row {
  border-inline-start: 0;
  padding: 5px 0;
  background: transparent;
  border-radius: 0;
}
.rec-panel--conversation .rec-row--child {
  margin-inline-start: 16px;
}
.rec-row__q {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rec-row__qtext {
  flex: 1;
  font-size: 13px;
  color: var(--hc-text-primary);
}
.rec-row__qtext :deep(p) {
  margin: 0;
}
.rec-row__edit {
  flex: 1;
  font-size: 13px;
  padding: 5px 8px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
.rec-row__toggle {
  font-size: 11.5px;
  padding: 3px 8px;
  border: none;
  border-radius: 7px;
  white-space: nowrap;
  background: transparent;
  color: var(--hc-accent);
  cursor: pointer;
}
.rec-row__kp {
  font-size: 11.5px;
  color: var(--hc-text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.rec-row__kpchip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.rec-row__recorded {
  font-size: 11px;
  color: var(--hc-text-muted);
}
/* INV-007 正确题单行摘要（口径复用错题档案侧单行行样式量级：紧凑、muted、可点展开） */
.rec-row__correct-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: start;
  font-size: 12px;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
}
.rec-row__correct-line {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--hc-success, #2f9e44);
}
.rec-row__correct-toggle {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--hc-accent);
}
@media (max-width: 700px) {
  .rec-pipeline__branches {
    grid-template-columns: 1fr;
  }
}
</style>
