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
  k12PrepCard,
  k12AddGrounding,
  k12Grade,
  k12RecordMistake,
  k12Solve,
  k12InsightReport,
  k12ListAccumulation,
  k12CreateGradingJob,
  k12GetGradingJob,
  k12GetGradingJobResult,
  k12ConfirmGradingJob,
  k12RetryGradingJob,
  k12CancelGradingJob,
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
  type PrepCardResp,
  type InsightReportResp,
  type RecognizedQuestion,
  type GradingJobStatusResp,
  type GradingQuestionCorrection,
  type PhotoJobResult,
  type TutorTurnReq,
  type TutorTurnResp,
  type BindIMReq,
  type ProvisionCronReq,
  type ProvisionedJob,
} from '@/api/k12'
import type { RecordCollectionView, VerifyResult } from '@/contracts'
import { i18n } from '@/i18n'
import {
  mistakesToView,
  gradeToResult,
  gradeToVerify,
  accumToView,
  type GradeViewResult,
} from './mappers'

/** 空白题解题结果（不含批改/入库语义）。 */
export interface SolveViewResult {
  verify: VerifyResult
  solution: string
  outOfScope: boolean
  outOfScopeKnowledgePoint?: string
}

export const useK12Store = defineStore('k12', () => {
  /** 当前实例（孩子）的错题本视图；多孩隔离 = 以 agent 拉取，切实例即换数据 */
  const mistakeView = ref<RecordCollectionView | null>(null)
  const accumView = ref<RecordCollectionView | null>(null)
  const report = ref<InsightReportResp | null>(null)
  const prepCard = ref<PrepCardResp | null>(null)
  const loading = ref(false)
  /** @deprecated 档案页改用各资源独立错误，保留空 ref 兼容旧调用方。 */
  const error = ref<string | null>(null)
  const mistakesError = ref<string | null>(null)
  const reportError = ref<string | null>(null)
  const accumulationError = ref<string | null>(null)
  let mistakesRequest = 0
  let reportRequest = 0
  let accumulationRequest = 0
  let prepRequest = 0

  /** 拉取某实例错题本 + 复习队列（合并为通用记录集视图） */
  async function loadMistakes(agent: string, status?: string): Promise<void> {
    const request = ++mistakesRequest
    loading.value = true
    mistakesError.value = null
    mistakeView.value = null
    try {
      const [all, due] = await Promise.all([k12ListMistakes(agent, status), k12ReviewQueue(agent)])
      if (request !== mistakesRequest) return
      mistakeView.value = mistakesToView(agent, all.items, due.items)
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
  const ACCUM_KEEP_TYPES = new Set(['好词好句', '古诗', '语法点', '作文', '古诗积累', '写作素材', '表达积累', '词汇积累'])

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

  /** 备课卡（事件驱动生成，非每日 cron）。
   *  状态独立（BUG-20260712-S）：不写共享 loading/error——此前 prep-card 的失败/中止
   *  （如切 tab 导致的 fetch abort）会把红字错误漏进错题本页（读共享 error 渲染）。 */
  const prepLoading = ref(false)
  const prepError = ref<string | null>(null)
  async function loadPrepCard(
    agent: string,
    grade: string,
    knowledgePoints?: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const request = ++prepRequest
    prepLoading.value = true
    prepError.value = null
    prepCard.value = null
    try {
      const next = await k12PrepCard({ agent, grade, knowledge_points: knowledgePoints }, signal)
      if (request === prepRequest) prepCard.value = next
    } catch {
      if (request !== prepRequest) return
      // 主动换孩子/换作业/离开会话属于正常取消，不应伪装成“生成失败”。
      if (signal?.aborted) return
      // 治本（BUG-20260712）：k12PrepCard 失败时 e.message 是裸技术串（「[POST] … Load failed」/
      // 「Fetch is aborted」），家长看不懂且吓人。统一翻成可操作的本地化提示（超时/网络中断 → 请重试 +
      // 慢本地模型可切云端）。原始错误对家长无价值，故不透出裸串。
      prepError.value = i18n.global.t('k12.prep.generateFailed')
    } finally {
      if (request === prepRequest) prepLoading.value = false
    }
  }

  /** 家长上传教材原文：按当前孩子 agent scope 入库；刷新由调用界面在确认仍是同一孩子后触发。 */
  async function addGrounding(
    agent: string,
    title: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await k12AddGrounding({ agent, title, content }, signal)
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
   *  friendly 错误：慢本地模型/网络超时的裸技术串对家长无价值，统一翻成可操作提示（同 prep 口径）。 */
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

  // ── 拍照批改编排（2026-07-18 桌面入口迁移到统一 GradingJob，§6.7/§6.15）──────
  // 上传照片 → 创建 Job（后端异步推进识别+锚点）→ 轮询到 awaiting_confirmation 停点 →
  // 护栏确认交互 → confirm → 轮询到 completed → 取逐题结果渲染。
  // 旧两阶段直连编排（k12Recognize/k12RecognizeAnchors）已随一次切换删除（§6.14 链路①）；
  // grade/solve 是甄别保留的单点能力（单题补批/空白题求解），不属旧编排链路。

  /** 轮询节流：阶段耗时分钟级（识别 ~1-3 分钟、整卷批改可达数分钟）→ 2.5s 间隔 + 10 分钟上限。 */
  const JOB_POLL_INTERVAL_MS = 2500
  const JOB_POLL_MAX_ATTEMPTS = 240

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

  /** 同一（agent, 照片）内容派生稳定幂等键（§4.10 desktop 来源键）：重复点击/失败重跑命中同一 Job。 */
  function photoJobSourceKey(agent: string, imageBase64: string): string {
    let hash = 5381
    for (let i = 0; i < imageBase64.length; i++) {
      hash = ((hash << 5) + hash + imageBase64.charCodeAt(i)) >>> 0
    }
    return `photo-${agent}-${hash.toString(16)}-${imageBase64.length}`
  }

  /** 轮询单个 Job 直到到达 stopStages 之一；失败态/超时抛家长向错误。 */
  async function pollGradingJob(
    agent: string,
    jobId: string,
    stopStages: string[],
    intervalMs = JOB_POLL_INTERVAL_MS,
    signal?: AbortSignal,
  ): Promise<GradingJobStatusResp> {
    for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt++) {
      throwIfAborted(signal)
      const status = await k12GetGradingJob(agent, jobId, signal)
      throwIfAborted(signal)
      if (stopStages.includes(status.stage)) return status
      if (
        status.stage === 'failed_terminal' ||
        status.stage === 'failed_retryable' ||
        status.stage === 'cancelled'
      ) {
        // 裸 failure_kind 对家长无价值：统一翻成可操作提示（可重试失败由调用方触发 retry 端点）。
        throw new Error(i18n.global.t('k12.recognize.jobFailed'))
      }
      if (attempt < JOB_POLL_MAX_ATTEMPTS - 1) {
        await waitForPoll(intervalMs, signal)
      }
    }
    throw new Error(i18n.global.t('k12.recognize.jobFailed'))
  }

  /** 护栏回显视图：Job 停点的识别产物 + 锚点态（degraded → 界面按无坐标文字降级提示）。 */
  interface PhotoJobRecognitionView {
    jobId: string
    questions: RecognizedQuestion[]
    subject: string
    anchorState: string
  }

  function photoJobRecognitionView(
    jobId: string,
    status: GradingJobStatusResp,
  ): PhotoJobRecognitionView {
    return {
      jobId,
      questions: status.recognition?.questions ?? status.job.recognized_questions ?? [],
      subject: status.recognition?.subject ?? '',
      anchorState: status.anchor_state,
    }
  }

  /**
   * 识别事实已可回显后，继续等待独立锚点分支落到 located/degraded。
   * 不能只看粗粒度 awaiting_confirmation：该 stage 下 anchor_state 仍可能是 pending。
   */
  async function waitForPhotoJobAnchor(
    agent: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<PhotoJobRecognitionView> {
    const cancelJob = () => {
      void k12CancelGradingJob(agent, jobId).catch(() => {
        // 任务可能恰好进入不可取消终态；本地仍必须隔离旧响应。
      })
    }
    signal?.addEventListener('abort', cancelJob, { once: true })
    try {
      for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt++) {
        throwIfAborted(signal)
        const status = await k12GetGradingJob(agent, jobId, signal)
        throwIfAborted(signal)
        if (status.anchor_state === 'located' || status.anchor_state === 'degraded') {
          return photoJobRecognitionView(jobId, status)
        }
        if (
          status.stage === 'failed_terminal' ||
          status.stage === 'failed_retryable' ||
          status.stage === 'cancelled'
        ) {
          throw new Error(i18n.global.t('k12.recognize.jobFailed'))
        }
        if (attempt < JOB_POLL_MAX_ATTEMPTS - 1) {
          await waitForPoll(JOB_POLL_INTERVAL_MS, signal)
        }
      }
      throw new Error(i18n.global.t('k12.recognize.jobFailed'))
    } finally {
      signal?.removeEventListener('abort', cancelJob)
    }
  }

  /**
   * 拍照识题（Job 化）：创建照片批改 Job → 后端异步推进（识别 + 锚点并行增强）→
   * 轮询到确认停点，返回识别产物供护栏回显。同图重投幂等命中既有 Job；
   * 命中可重试失败任务时自动走 retry 端点从检查点续跑（识别失败可重试）。
   */
  async function recognizePhotoJob(
    agent: string,
    imageBase64: string,
    signal?: AbortSignal,
  ): Promise<PhotoJobRecognitionView> {
    loading.value = true
    error.value = null
    let jobId = ''
    const cancelJob = () => {
      if (!jobId) return
      void k12CancelGradingJob(agent, jobId).catch(() => {
        // 任务可能恰好进入不可取消终态；本地仍必须隔离旧响应。
      })
    }
    signal?.addEventListener('abort', cancelJob)
    try {
      throwIfAborted(signal)
      const created = await k12CreateGradingJob({
          agent,
          source_key: photoJobSourceKey(agent, imageBase64),
          source_kind: 'desktop',
          image_base64: imageBase64,
      }, signal)
      jobId = created.job.job_id
      if (signal?.aborted) {
        cancelJob()
        throw abortError()
      }
      if (!created.created && created.job.stage === 'failed_retryable' && created.job.retryable) {
        await k12RetryGradingJob(agent, jobId, signal)
      }
      // completed 也是合法停点（同图重投命中已完成 Job）：识别产物仍可回显。
      const status = await pollGradingJob(
        agent,
        jobId,
        ['awaiting_confirmation', 'completed'],
        JOB_POLL_INTERVAL_MS,
        signal,
      )
      return photoJobRecognitionView(jobId, status)
    } finally {
      signal?.removeEventListener('abort', cancelJob)
      loading.value = false
    }
  }

  /**
   * 整卷批改（Job 化）：批量确认/修正识别结果（冻结 canonical 输入，§6.7 规则 1）→
   * 后端异步续跑 assessing→rendering→projecting → 轮询到 completed → 返回逐题结果
   * （PhotoGradeOverlay 数据源）。
   */
  async function gradePhotoJob(
    agent: string,
    jobId: string,
    input: { subject?: string; grade?: string; corrections?: GradingQuestionCorrection[] },
  ): Promise<PhotoJobResult> {
    await k12ConfirmGradingJob(jobId, {
      agent,
      subject: input.subject,
      grade: input.grade,
      question_corrections: input.corrections,
    })
    await pollGradingJob(agent, jobId, ['completed'])
    const projection = await k12GetGradingJobResult(agent, jobId)
    if (!projection.result) {
      throw new Error(i18n.global.t('k12.recognize.jobFailed'))
    }
    return projection.result
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
   * 建档后一键接线：把家庭群绑到实例（入站路由）+ 注册默认自动化任务（错题卷/提醒/月报/学期确认）。
   * platform/chatId 为空时只注册桌面 chat 投递、跳过 IM 绑定。桌面无 cron/router 时后端返回 501，
   * 这里吞掉 501 让建档不因自动化缺失而失败（自动化是增强项）。
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
    prepCard,
    prepLoading,
    prepError,
    loading,
    error,
    mistakesError,
    reportError,
    accumulationError,
    loadMistakes,
    markMastered,
    deleteMistake,
    loadPrepCard,
    addGrounding,
    loadReport,
    loadAccumulation,
    grade,
    recordMistake,
    solve,
    recognizePhotoJob,
    waitForPhotoJobAnchor,
    gradePhotoJob,
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
