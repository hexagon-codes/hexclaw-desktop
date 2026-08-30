/**
 * K12 数据 store（features/k12）· 对接真实 /api/k12/*。
 * 通用 shell 组件只消费投影后的 RecordCollectionView / VerifyResult，不认识本 store。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  k12ListMistakes,
  k12ReviewQueue,
  k12MarkMastered,
  k12DeleteMistake,
  k12SuppressMistake,
  k12RestoreMistakeReview,
  k12TutoringTips,
  k12Grade,
  k12RecordMistake,
  k12Solve,
  k12InsightReport,
  k12ListAccumulation,
  k12UploadAsset,
  k12CreateImageTask,
  k12GetImageTask,
  k12GetImageTaskResult,
  k12ConfirmImageTask,
  k12RetryImageTask,
  k12CancelImageTask,
  k12ColdStart,
  k12TutorTurn,
  k12BindIM,
  k12ProvisionCron,
  type GradeReq,
  type RecordMistakeReq,
  type RecordMistakeResp,
  type SolveReq,
  type ColdStartReq,
  type ColdStartResp,
  type TutoringTipsResp,
  type InsightReportResp,
  type RecognizedQuestion,
  type GradingQuestionCorrection,
  type PhotoJobResult,
  type ImageTaskDispatchDTO,
  type ImageTaskHomeworkProjectionDTO,
  type ImageTaskCreativeProjectionDTO,
  type ImageTaskCreativeFeedbackState,
  type ImageTaskIntent,
  type ImageTaskResultProjection,
  type ConfirmImageTaskReq,
  type TutorTurnReq,
  type TutorTurnResp,
  type BindIMReq,
  type ProvisionCronReq,
  type ProvisionedJob,
  type MistakeDTO,
} from '@/api/k12'
import type { RecordCollectionView, VerifyResult } from '@/contracts'
import type {
  ScenarioComposerImageAssetReceipt,
  ScenarioImageModelRoute,
} from '@/shell/scenario/registry'
import { i18n } from '@/i18n'
import {
  mistakesToView,
  mistakeToRecord,
  gradeToResult,
  gradeToVerify,
  accumToView,
  type GradeViewResult,
} from './mappers'
import {
  clearImageTaskBinding,
  getImageTaskBinding,
  setImageTaskBinding,
} from './image-task-binding'

/** 空白题解题结果（不含批改/入库语义）。 */
export interface SolveViewResult {
  verify: VerifyResult
  solution: string
  outOfScope: boolean
  outOfScopeKnowledgePoint?: string
}

export type ImageTaskCompletionOutcome =
  | {
      stage: 'completed'
      taskIntent: 'completed_homework' | 'blank_worksheet'
      result: PhotoJobResult
    }
  | {
      stage: 'promoted'
      taskIntent: 'writing' | 'artwork'
      result: Extract<ImageTaskResultProjection, { kind: 'writing' | 'artwork' }>['payload']
    }

export interface ImageTaskView {
  dispatchId: string
  dispatchVersion: number
  createdAt?: number
  completedAt?: number
  automaticBudgetSeconds?: number
  automaticStartedAt?: number
  automaticDeadlineAt?: number
  automaticRemainingSeconds?: number
  operationDeadlineAt?: number
  taskIntent: ImageTaskIntent
  stage: string
  retryable?: boolean
  questions: RecognizedQuestion[]
  subject: string
  anchorState: 'pending' | 'located' | 'degraded'
  confirmationState: 'pending' | 'confirmed'
  creative?: ImageTaskCreativeProjectionDTO
  intentCandidates: ImageTaskIntent[]
}

type ImageTaskStatusObserver = (dispatch: ImageTaskDispatchDTO) => void

export const useK12Store = defineStore('k12', () => {
  /** 当前实例（孩子）的错题本视图；多孩隔离 = 以 agent 拉取，切实例即换数据 */
  const mistakeView = ref<RecordCollectionView | null>(null)
  const accumView = ref<RecordCollectionView | null>(null)
  const report = ref<InsightReportResp | null>(null)
  const tutoringTips = ref<TutoringTipsResp | null>(null)
  const loading = ref(false)
  /** @deprecated 档案页改用各资源独立错误，保留空 ref 兼容旧调用方。 */
  const error = ref<string | null>(null)
  const mistakesError = ref<string | null>(null)
  const reportError = ref<string | null>(null)
  const accumulationError = ref<string | null>(null)
  let mistakesRequest = 0
  let mistakesAgent = ''
  let reportRequest = 0
  let accumulationRequest = 0
  let tutoringTipsRequest = 0

  /** 拉取某实例错题本 + 复习队列（合并为通用记录集视图） */
  async function loadMistakes(agent: string, status?: string): Promise<void> {
    const request = ++mistakesRequest
    const sameAgent = mistakesAgent === agent
    mistakesAgent = agent
    loading.value = true
    mistakesError.value = null
    // 同一孩子的刷新保留已经展示/由受控命令确认的正式投影；否则归档 2xx
    // 与刷新并发时，刷新先清空视图会让命令响应无处落盘。切换孩子仍立即清空，
    // 保持多孩隔离，迟到请求继续由 request 序号丢弃。
    if (!sameAgent) mistakeView.value = null
    try {
      const [all, due] = await Promise.all([k12ListMistakes(agent, status), k12ReviewQueue(agent)])
      if (request !== mistakesRequest) return
      mistakeView.value = mistakesToView(agent, all.items, due.items, all.total)
    } catch (e) {
      if (request !== mistakesRequest) return
      mistakesError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (request === mistakesRequest) loading.value = false
    }
  }

  /** 「他会了」→ mark-mastered（乐观锁）后局部刷新 */
  async function markMastered(agent: string, recordId: string, version: number): Promise<void> {
    await k12MarkMastered({ agent, record_id: recordId, version })
    await loadMistakes(agent)
  }

  /** 「删除这条错题」→ delete-mistake（数据纠错）后重载列表 */
  async function deleteMistake(agent: string, recordId: string): Promise<void> {
    await k12DeleteMistake(agent, recordId)
    await loadMistakes(agent)
  }

  function replaceMistakeProjection(agent: string, dto: MistakeDTO) {
    const current = mistakeView.value
    if (!current) return
    const index = current.items.findIndex(
      (item) => item.agentId === agent && item.recordId === dto.record_id,
    )
    if (index < 0) return

    const existing = current.items[index]!
    const subject =
      typeof existing.fields.subject === 'string' ? existing.fields.subject : undefined
    const projected = mistakeToRecord(dto, agent, subject)
    const nextItem = {
      ...existing,
      ...projected,
      fields: {
        ...existing.fields,
        ...projected.fields,
        review_kind: projected.fields.review_kind ?? existing.fields.review_kind,
      },
    }
    const items = current.items.slice()
    items[index] = nextItem
    const statusCounts: Record<string, number> = {}
    for (const item of items) {
      if (item.status) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1
    }

    const queue = (current.reviewQueue ?? []).filter((id) => id !== dto.record_id)
    const dueNow =
      dto.status !== 'archived' &&
      dto.due_at != null &&
      dto.due_at <= Math.floor(Date.now() / 1_000)
    if (dueNow) queue.push(dto.record_id)
    mistakeView.value = {
      ...current,
      items,
      reviewQueue: queue,
      statusCounts,
    }
  }

  /**
   * 已提交命令后的服务端校准：失败只保留当前正式投影，不清空视图、不把无关刷新并入事务。
   * request 序号仍阻止旧孩子的迟到响应覆盖新孩子。
   */
  async function calibrateMistakes(agent: string): Promise<void> {
    const request = ++mistakesRequest
    try {
      const [all, due] = await Promise.all([k12ListMistakes(agent), k12ReviewQueue(agent)])
      if (request !== mistakesRequest) return
      mistakeView.value = mistakesToView(agent, all.items, due.items)
      mistakesError.value = null
    } catch (error) {
      if (request !== mistakesRequest || mistakeView.value) return
      mistakesError.value = error instanceof Error ? error.message : String(error)
    }
  }

  function mistakeCommandKey(action: 'suppress' | 'restore', agent: string, recordId: string) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    return `desktop-mistake-${action}:${agent}:${recordId}:${random}`
  }

  function controlledCommandMayHaveCommitted(error: unknown): boolean {
    const status = httpStatus(error)
    return status == null || status >= 500 || status === 408 || status === 425 || status === 429
  }

  /** CAS 长期排除命令；不产生掌握证据。 */
  async function suppressMistake(agent: string, recordId: string, version: number) {
    const key = mistakeCommandKey('suppress', agent, recordId)
    try {
      const archived = await k12SuppressMistake(agent, recordId, version, key)
      replaceMistakeProjection(agent, archived)
      return archived
    } catch (error) {
      // 响应丢失时，用同一幂等键安全读取/重放正式结果；绝不换 key 生成第二个意图。
      if (!controlledCommandMayHaveCommitted(error)) throw error
      const archived = await k12SuppressMistake(agent, recordId, version, key)
      replaceMistakeProjection(agent, archived)
      return archived
    }
  }

  /** Undo 与长期恢复的唯一命令；禁止本地伪造恢复状态。 */
  async function restoreMistakeReview(agent: string, recordId: string, version: number) {
    const key = mistakeCommandKey('restore', agent, recordId)
    try {
      const restored = await k12RestoreMistakeReview(agent, recordId, version, key)
      replaceMistakeProjection(agent, restored)
      return restored
    } catch (error) {
      if (!controlledCommandMayHaveCommitted(error)) throw error
      const restored = await k12RestoreMistakeReview(agent, recordId, version, key)
      replaceMistakeProjection(agent, restored)
      return restored
    }
  }

  /** @deprecated 测试与旧插件兼容别名；不得再作为产品语义。 */
  const archiveMistake = suppressMistake
  /** @deprecated 测试与旧插件兼容别名。 */
  const restoreMistake = restoreMistakeReview

  /** 学情报告（真实端点，替代客户端聚合） */
  async function loadReport(agent: string): Promise<void> {
    const request = ++reportRequest
    reportError.value = null
    report.value = null
    try {
      const next = await k12InsightReport(agent)
      if (request === reportRequest) report.value = next
    } catch (e) {
      if (request !== reportRequest) return
      reportError.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 积累本（语/英）；subject 可选，触达后端分科过滤（BUG-3）。 */
  // 积累型 entry_type（镜像后端 accumKeepTypes）——「积累」tab 只显这些；纠错型（默写错/错词/语法改错）
  // 属客观错误、进「错题」tab 的复习队列（PRD §3.5.4 口径）。
  // 20260718 原型定案：类型按学科分化（语文：好词好句/古诗积累/写作素材；英语：表达积累/词汇积累）；
  // 前四项为存量旧词汇，展示侧兼容保留，新录入走分化词汇（后端 accumKeepTypes 需同步扩集，缺口挂执行计划）。
  const ACCUM_KEEP_TYPES = new Set([
    '好词好句',
    '古诗',
    '语法点',
    '作文',
    '古诗积累',
    '写作素材',
    '表达积累',
    '词汇积累',
  ])

  async function loadAccumulation(agent: string, subject?: string): Promise<void> {
    const request = ++accumulationRequest
    accumulationError.value = null
    accumView.value = null
    try {
      const res = await k12ListAccumulation(agent, subject)
      if (request !== accumulationRequest) return
      // 「积累」tab 只留积累型；纠错型（听写/默写/改错）已在「错题」tab 的跨科复习队列呈现。
      const keepOnly = res.items.filter((it) => ACCUM_KEEP_TYPES.has(it.entry_type))
      accumView.value = accumToView(agent, keepOnly)
    } catch (e) {
      if (request !== accumulationRequest) return
      accumulationError.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 辅导要点（确认后的当前 Job 事件驱动生成，非每日 cron）。
   *  状态独立（BUG-20260712-S）：不写共享 loading/error——此前 tutoring-tips 的失败/中止
   *  （如切 tab 导致的 fetch abort）会把红字错误漏进错题本页（读共享 error 渲染）。 */
  const tutoringTipsLoading = ref(false)
  const tutoringTipsError = ref<string | null>(null)
  async function loadTutoringTips(
    agent: string,
    dispatchId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // 辅导要点只能基于服务端已确认图片任务；内部批改实体由服务端解析，客户端不持有内部 ID。
    if (!agent.trim() || !dispatchId.trim()) return
    const request = ++tutoringTipsRequest
    tutoringTipsLoading.value = true
    tutoringTipsError.value = null
    tutoringTips.value = null
    try {
      const next = await k12TutoringTips({ agent, dispatch_id: dispatchId }, signal)
      if (request === tutoringTipsRequest) tutoringTips.value = next
    } catch {
      if (request !== tutoringTipsRequest) return
      // 主动换孩子/换作业/离开会话属于正常取消，不应伪装成“生成失败”。
      if (signal?.aborted) return
      // 治本（BUG-20260712）：k12TutoringTips 失败时 e.message 是裸技术串（「[POST] … Load failed」/
      // 「Fetch is aborted」），家长看不懂且吓人。统一翻成可操作的本地化提示（超时/网络中断 → 请重试 +
      // 慢本地模型可切云端）。原始错误对家长无价值，故不透出裸串。
      tutoringTipsError.value = i18n.global.t('k12.tutoringTips.generateFailed')
    } finally {
      if (request === tutoringTipsRequest) tutoringTipsLoading.value = false
    }
  }

  /** 批改一道题 → 验算徽章数据 + 是否入库 */
  async function grade(req: GradeReq): Promise<GradeViewResult> {
    const resp = await k12Grade(req)
    return gradeToResult(resp)
  }

  /** 「记一条错题」→ 轻量直录错题本（已知错题，不跑对抗验算链，秒级完成）。 */
  async function recordMistake(req: RecordMistakeReq): Promise<RecordMistakeResp> {
    return await k12RecordMistake(req)
  }

  /** 空白/未作答题求解（单一真相源分叉的「空白卷」路径）→ 解法 + 验算徽章，不批改、不入库。
   *  friendly 错误：慢本地模型/网络超时的裸技术串对家长无价值，统一翻成可操作提示。 */
  async function solve(req: SolveReq): Promise<SolveViewResult> {
    try {
      const resp = await k12Solve(req)
      return {
        // gradeToVerify 只读 badge/evidence_type/out_of_scope[_kp]，SolveResp 全部具备（结构子集）。
        verify: gradeToVerify(resp as unknown as import('@/api/k12').GradeResp),
        solution: resp.solution,
        outOfScope: resp.out_of_scope,
        outOfScopeKnowledgePoint: resp.out_of_scope_kp,
      }
    } catch {
      throw new Error(i18n.global.t('k12.recognize.solveFailed'))
    }
  }

  // ── 四类图片任务统一 facade（ImageTaskDispatch，§3.2/§5.4）──────────────
  // Desktop 先固化不可变 Asset，再只通过 /image-tasks 驱动分流根对象。作业类的
  // 作业与作品的内部目标都由服务端持有；本 store 只消费公开投影。
  const JOB_POLL_INTERVAL_MS = 2500

  function abortError(): Error {
    const error = new Error('识题已取消')
    error.name = 'AbortError'
    return error
  }

  function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError()
  }

  function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
    throwIfAborted(signal)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 仅历史消息或显式重提的 data URL 兼容入口；新选择/拖入必须优先传 original File。 */
  function legacyDataURLFile(dataUrl: string, sourceRef: string): File {
    const comma = dataUrl.indexOf(',')
    const metadata = comma >= 0 ? dataUrl.slice(0, comma) : ''
    const encoded = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    const mime = /^data:([^;,]+)/.exec(metadata)?.[1] ?? 'image/jpeg'
    const binary = atob(encoded.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
    return new File([bytes], `image-task-${sourceRef}.${extension}`, { type: mime })
  }

  function homeworkProjection(
    dispatch: ImageTaskDispatchDTO,
  ): ImageTaskHomeworkProjectionDTO | undefined {
    return dispatch.target_projection?.kind === 'homework' ? dispatch.target_projection : undefined
  }

  function creativeFeedbackState(
    dispatch: ImageTaskDispatchDTO,
  ): ImageTaskCreativeFeedbackState | undefined {
    if (
      dispatch.target_projection?.kind !== 'creative' ||
      dispatch.target_projection.status !== 'promoted' ||
      dispatch.progress.operation !== 'promotion'
    ) {
      return undefined
    }
    const state = dispatch.progress.state
    return ['feedback_pending', 'feedback_ready', 'feedback_failed', 'recovering'].includes(state)
      ? (state as ImageTaskCreativeFeedbackState)
      : undefined
  }

  function imageTaskView(dispatch: ImageTaskDispatchDTO): ImageTaskView {
    const homework = homeworkProjection(dispatch)
    const creative =
      dispatch.target_projection?.kind === 'creative' ? dispatch.target_projection : undefined
    const feedbackState = creativeFeedbackState(dispatch)
    return {
      dispatchId: dispatch.dispatch_id,
      dispatchVersion: dispatch.version,
      createdAt: dispatch.created_at,
      completedAt: homework?.completed_at,
      automaticBudgetSeconds: dispatch.automatic_budget_seconds,
      automaticStartedAt: dispatch.automatic_started_at,
      automaticDeadlineAt: dispatch.automatic_deadline_at,
      automaticRemainingSeconds: dispatch.automatic_remaining_seconds,
      operationDeadlineAt: dispatch.operation_deadline_at,
      taskIntent: dispatch.task_intent,
      stage: homework?.stage ?? feedbackState ?? creative?.status ?? dispatch.status,
      retryable: dispatch.retryable === true,
      questions: homework?.recognition?.questions ?? [],
      subject: homework?.recognition?.subject ?? '',
      anchorState: homework?.anchor_state ?? 'pending',
      confirmationState: homework?.confirmation_state ?? 'pending',
      creative,
      intentCandidates: dispatch.confirmation_candidates,
    }
  }

  function isFacadeFailure(dispatch: ImageTaskDispatchDTO): boolean {
    if (dispatch.status === 'failed' || dispatch.status === 'cancelled') return true
    const projection = dispatch.target_projection
    if (projection?.kind === 'homework') {
      return (
        projection.stage === 'failed_retryable' ||
        projection.stage === 'failed_terminal' ||
        projection.stage === 'cancelled'
      )
    }
    if (creativeFeedbackState(dispatch) === 'feedback_failed') return true
    return projection?.kind === 'creative'
      ? projection.status === 'failed' || projection.status === 'cancelled'
      : false
  }

  function readyForTaskShell(dispatch: ImageTaskDispatchDTO): boolean {
    if (isFacadeFailure(dispatch) || dispatch.status === 'awaiting_confirmation') return true
    const projection = dispatch.target_projection
    if (projection?.kind === 'homework') {
      const hasFactConflict =
        projection.recognition?.questions.some((question) => question.confirmation_required) ??
        false
      return (
        projection.stage === 'completed' ||
        (projection.stage === 'awaiting_confirmation' &&
          projection.confirmation_state === 'pending' &&
          hasFactConflict)
      )
    }
    if (projection?.kind !== 'creative') return false
    const feedbackState = creativeFeedbackState(dispatch)
    return (
      (projection.work_type === 'writing' &&
        projection.status === 'awaiting_confirmation' &&
        !!projection.conflicts?.length) ||
      feedbackState === 'feedback_ready' ||
      feedbackState === 'feedback_failed'
    )
  }

  function resultReady(dispatch: ImageTaskDispatchDTO): boolean {
    const projection = dispatch.target_projection
    if (projection?.kind === 'homework') return projection.stage === 'completed'
    if (projection?.kind === 'creative') {
      return creativeFeedbackState(dispatch) === 'feedback_ready'
    }
    return false
  }

  async function pollImageTask(
    agent: string,
    dispatchId: string,
    stop: (dispatch: ImageTaskDispatchDTO) => boolean,
    intervalMs = JOB_POLL_INTERVAL_MS,
    signal?: AbortSignal,
    onStatus?: ImageTaskStatusObserver,
  ): Promise<ImageTaskDispatchDTO> {
    for (;;) {
      throwIfAborted(signal)
      const response = await k12GetImageTask(agent, dispatchId, signal)
      throwIfAborted(signal)
      onStatus?.(response.dispatch)
      if (stop(response.dispatch)) return response.dispatch
      await waitForPoll(intervalMs, signal)
    }
  }

  /** 已取得一次快照后的续轮询。先等待一个 polling interval，避免同一调用栈重复 GET。 */
  async function continuePollingImageTask(
    agent: string,
    dispatchId: string,
    stop: (dispatch: ImageTaskDispatchDTO) => boolean,
    intervalMs: number,
    signal?: AbortSignal,
    onStatus?: ImageTaskStatusObserver,
  ): Promise<ImageTaskDispatchDTO> {
    await waitForPoll(intervalMs, signal)
    return pollImageTask(agent, dispatchId, stop, intervalMs, signal, onStatus)
  }

  async function dispatchImageTask(
    input: {
      agent: string
      /** 新选择/拖入路径直接交付原始 File（可能带 native grant），禁止先变 data URL。 */
      file?: File
      /** 仅历史消息或显式重提兼容；新选择/拖入不得赋值。 */
      dataUrl?: string
      sourceSession: string
      sourceRef: string
      messageIntent?: string
      route?: ScenarioImageModelRoute
      attemptGeneration?: number
      /** K12 asset receipt 后由 shell 持久同一用户消息；失败时不能创建 ImageTask。 */
      onSourceStored?: (receipt: ScenarioComposerImageAssetReceipt) => Promise<boolean>
    },
    signal?: AbortSignal,
    onStatus?: ImageTaskStatusObserver,
  ): Promise<ImageTaskView> {
    const sourceSession = input.sourceSession.trim()
    const sourceRef = input.sourceRef.trim()
    if (!input.agent.trim() || !sourceSession || !sourceRef) {
      throw new Error('desktop image task identity is required')
    }
    loading.value = true
    error.value = null
    try {
      throwIfAborted(signal)
      const sourceFile =
        input.file ??
        (input.dataUrl?.trim() ? legacyDataURLFile(input.dataUrl, sourceRef) : undefined)
      if (!sourceFile) {
        throw new Error('desktop image task source is required')
      }
      const asset = await k12UploadAsset(input.agent, sourceFile, undefined, signal)
      throwIfAborted(signal)
      if (input.onSourceStored) {
        const persisted = await input.onSourceStored({
          assetId: asset.asset_id,
        })
        if (!persisted) throw new Error('desktop image task source persistence failed')
      }
      throwIfAborted(signal)
      const created = await k12CreateImageTask(
        {
          agent: input.agent,
          source_session: sourceSession,
          source_kind: 'desktop',
          source_ref: sourceRef,
          source_asset_refs: [asset.asset_id],
          ...(input.messageIntent?.trim() ? { message_intent: input.messageIntent.trim() } : {}),
          attempt_generation: input.attemptGeneration ?? 1,
          route_request: input.route
            ? {
                provider: input.route.provider,
                model: input.route.model,
                selection_source: 'explicit',
              }
            : { selection_source: 'auto' },
        },
        signal,
      )
      onStatus?.(created.dispatch)
      const dispatchId = created.dispatch.dispatch_id
      setImageTaskBinding(sourceSession, input.agent, sourceRef, dispatchId)
      throwIfAborted(signal)
      const dispatch = readyForTaskShell(created.dispatch)
        ? created.dispatch
        : await pollImageTask(
            input.agent,
            dispatchId,
            readyForTaskShell,
            JOB_POLL_INTERVAL_MS,
            signal,
            onStatus,
          )
      if (isFacadeFailure(dispatch)) {
        throw new Error(i18n.global.t('k12.recognize.jobFailed'))
      }
      return imageTaskView(dispatch)
    } finally {
      loading.value = false
    }
  }

  async function waitForImageTaskHomeworkAnchor(
    agent: string,
    dispatchId: string,
    signal?: AbortSignal,
  ): Promise<ImageTaskView> {
    const dispatch = await pollImageTask(
      agent,
      dispatchId,
      (candidate) => {
        if (isFacadeFailure(candidate)) return true
        const homework = homeworkProjection(candidate)
        return (
          homework?.stage === 'completed' ||
          homework?.anchor_state === 'located' ||
          homework?.anchor_state === 'degraded'
        )
      },
      JOB_POLL_INTERVAL_MS,
      signal,
    )
    if (isFacadeFailure(dispatch)) {
      throw new Error(i18n.global.t('k12.recognize.jobFailed'))
    }
    return imageTaskView(dispatch)
  }

  async function confirmImageTask(
    agent: string,
    dispatchId: string,
    version: number,
    input: {
      intent?: ImageTaskIntent
      subject?: string
      grade?: string
      corrections?: GradingQuestionCorrection[]
      creative?: Extract<NonNullable<ConfirmImageTaskReq['creative']>, { action: 'freeze_ocr' }>
    },
    signal?: AbortSignal,
  ): Promise<ImageTaskView> {
    throwIfAborted(signal)
    const response = await k12ConfirmImageTask(
      dispatchId,
      {
        agent,
        version,
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.corrections
          ? {
              homework: {
                subject: input.subject,
                grade: input.grade,
                question_corrections: input.corrections,
              },
            }
          : {}),
        ...(input.creative ? { creative: input.creative } : {}),
      },
      signal,
    )
    return imageTaskView(response.dispatch)
  }

  async function retryImageTask(
    agent: string,
    dispatchId: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<ImageTaskView> {
    throwIfAborted(signal)
    const response = await k12RetryImageTask(dispatchId, { agent, version }, signal)
    throwIfAborted(signal)
    return imageTaskView(response.dispatch)
  }

  async function cancelImageTask(
    agent: string,
    dispatchId: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<ImageTaskView> {
    throwIfAborted(signal)
    const response = await k12CancelImageTask(dispatchId, { agent, version }, signal)
    throwIfAborted(signal)
    return imageTaskView(response.dispatch)
  }

  async function completeImageTask(
    agent: string,
    dispatchId: string,
    _input: { sourceSession?: string },
    signal?: AbortSignal,
    onStatus?: ImageTaskStatusObserver,
  ): Promise<ImageTaskCompletionOutcome> {
    throwIfAborted(signal)
    const response = await k12GetImageTask(agent, dispatchId, signal)
    throwIfAborted(signal)
    onStatus?.(response.dispatch)
    const dispatch = resultReady(response.dispatch)
      ? response.dispatch
      : await continuePollingImageTask(
          agent,
          dispatchId,
          (candidate) => resultReady(candidate) || isFacadeFailure(candidate),
          JOB_POLL_INTERVAL_MS,
          signal,
          onStatus,
        )
    if (isFacadeFailure(dispatch)) {
      throw new Error(i18n.global.t('k12.recognize.jobFailed'))
    }
    const projection = await k12GetImageTaskResult(agent, dispatchId, signal)
    if (!projection.result || projection.task_intent !== dispatch.task_intent) {
      throw new Error(i18n.global.t('k12.recognize.jobFailed'))
    }
    if (
      (projection.task_intent === 'completed_homework' &&
        projection.result.kind === 'completed_homework') ||
      (projection.task_intent === 'blank_worksheet' && projection.result.kind === 'blank_worksheet')
    ) {
      return {
        stage: 'completed',
        taskIntent: projection.task_intent,
        result: projection.result.payload,
      }
    }
    if (
      (projection.task_intent === 'writing' && projection.result.kind === 'writing') ||
      (projection.task_intent === 'artwork' && projection.result.kind === 'artwork')
    ) {
      return {
        stage: 'promoted',
        taskIntent: projection.task_intent,
        result: projection.result.payload,
      }
    }
    throw new Error(i18n.global.t('k12.recognize.jobFailed'))
  }

  async function restoreImageTask(
    agent: string,
    sourceSession: string | undefined,
    signal?: AbortSignal,
    onStatus?: ImageTaskStatusObserver,
  ): Promise<ImageTaskView | null> {
    const binding = getImageTaskBinding(sourceSession, agent)
    if (!binding) return null
    try {
      const response = await k12GetImageTask(agent, binding.dispatchId, signal)
      throwIfAborted(signal)
      onStatus?.(response.dispatch)
      const dispatch = readyForTaskShell(response.dispatch)
        ? response.dispatch
        : await continuePollingImageTask(
            agent,
            binding.dispatchId,
            readyForTaskShell,
            JOB_POLL_INTERVAL_MS,
            signal,
            onStatus,
          )
      return imageTaskView(dispatch)
    } catch (error) {
      const code = httpStatus(error)
      if (code === 403 || code === 404) {
        clearImageTaskBinding(sourceSession, agent, binding.dispatchId)
        return null
      }
      throw error
    }
  }

  async function restoreImageTaskDispatch(
    agent: string,
    input: {
      sourceSession: string
      sourceMessageId: string
      dispatchId: string
    },
    signal?: AbortSignal,
    onStatus?: ImageTaskStatusObserver,
  ): Promise<ImageTaskView | null> {
    try {
      const response = await k12GetImageTask(agent, input.dispatchId, signal)
      throwIfAborted(signal)
      onStatus?.(response.dispatch)
      const dispatch = readyForTaskShell(response.dispatch)
        ? response.dispatch
        : await continuePollingImageTask(
            agent,
            input.dispatchId,
            readyForTaskShell,
            JOB_POLL_INTERVAL_MS,
            signal,
            onStatus,
          )
      return imageTaskView(dispatch)
    } catch (error) {
      const code = httpStatus(error)
      if (code === 403 || code === 404) {
        clearImageTaskBinding(input.sourceSession, agent, input.sourceMessageId, input.dispatchId)
        return null
      }
      throw error
    }
  }

  /** 渐进提示一轮：返回分阶段指令 + 守门标志（阶段三带验算解） */
  async function tutorTurn(req: TutorTurnReq): Promise<TutorTurnResp> {
    return await k12TutorTurn(req)
  }

  /**
   * 冷启动倒查建档（PRD §3.1.4-4）：据识题产出的知识点倒查课标推断年级并落库。
   * 前提：agent 已存在 + knowledge_points 非空（由识题给出）；端点即落库，回显供家长事后核对/改档。
   */
  async function coldStart(req: ColdStartReq): Promise<ColdStartResp> {
    return await k12ColdStart(req)
  }

  /**
   * 档案保存后一键接线：把家庭群绑到实例（入站路由）+ missing-only 补齐冻结的四个默认任务。
   * platform/chatId 为空时只补桌面 chat 缺项、跳过 IM 绑定。已有 exact SourceKey 任务由后端
   * 原样保留；桌面无 cron/router 时后端返回 501，这里降级为空，让档案保存不被增强项阻断。
   */
  async function setupAutomation(
    agent: string,
    opts?: { platform?: string; chatId?: string; deliver?: string[] },
  ): Promise<ProvisionedJob[]> {
    const platform = opts?.platform
    const chatId = opts?.chatId
    if (platform && chatId) {
      const bind: BindIMReq = { agent, platform, chat_id: chatId }
      try {
        await k12BindIM(bind)
      } catch (e) {
        if (!isNotImplemented(e)) throw e
      }
    }
    const prov: ProvisionCronReq = { agent, platform, chat_id: chatId, deliver: opts?.deliver }
    try {
      const resp = await k12ProvisionCron(prov)
      return resp.provisioned
    } catch (e) {
      if (isNotImplemented(e)) return []
      throw e
    }
  }

  return {
    mistakeView,
    accumView,
    report,
    tutoringTips,
    tutoringTipsLoading,
    tutoringTipsError,
    loading,
    error,
    mistakesError,
    reportError,
    accumulationError,
    loadMistakes,
    calibrateMistakes,
    markMastered,
    deleteMistake,
    archiveMistake,
    restoreMistake,
    suppressMistake,
    restoreMistakeReview,
    loadTutoringTips,
    loadReport,
    loadAccumulation,
    grade,
    recordMistake,
    solve,
    dispatchImageTask,
    pollImageTask,
    waitForImageTaskHomeworkAnchor,
    confirmImageTask,
    retryImageTask,
    cancelImageTask,
    completeImageTask,
    restoreImageTask,
    restoreImageTaskDispatch,
    coldStart,
    tutorTurn,
    setupAutomation,
  }
})

/** 后端 501（未注入 cron/router，如非桌面运行时）→ 返回空集，由调用 UI 显式提示且不阻断建档。 */
function isNotImplemented(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('501') || msg.includes('未注入')
}

function httpStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  } | null
  const value = candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status
  return typeof value === 'number' ? value : undefined
}
