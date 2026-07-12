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
  k12PrepCard,
  k12Grade,
  k12Solve,
  k12InsightReport,
  k12StudyTime,
  k12ListAccumulation,
  k12Recognize,
  k12ColdStart,
  k12TutorTurn,
  k12BindIM,
  k12ProvisionCron,
  type GradeReq,
  type SolveReq,
  type ColdStartReq,
  type ColdStartResp,
  type PrepCardResp,
  type InsightReportResp,
  type StudyTimeResp,
  type RecognizedQuestion,
  type RecognizeResp,
  type TutorTurnReq,
  type TutorTurnResp,
  type BindIMReq,
  type ProvisionCronReq,
  type ProvisionedJob,
} from '@/api/k12'
import type { RecordCollectionView, VerifyResult } from '@/contracts'
import { i18n } from '@/i18n'
import { mistakesToView, gradeToResult, gradeToVerify, accumToView, type GradeViewResult } from './mappers'

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
  const studyTime = ref<StudyTimeResp | null>(null)
  const prepCard = ref<PrepCardResp | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let mistakesRequest = 0
  let reportRequest = 0
  let studyTimeRequest = 0
  let accumulationRequest = 0

  /** 拉取某实例错题本 + 复习队列（合并为通用记录集视图） */
  async function loadMistakes(agent: string, status?: string): Promise<void> {
    const request = ++mistakesRequest
    loading.value = true
    error.value = null
    mistakeView.value = null
    try {
      const [all, due] = await Promise.all([k12ListMistakes(agent, status), k12ReviewQueue(agent)])
      if (request !== mistakesRequest) return
      mistakeView.value = mistakesToView(agent, all.items, due.items)
    } catch (e) {
      if (request !== mistakesRequest) return
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (request === mistakesRequest) loading.value = false
    }
  }

  /** 「他会了」→ mark-mastered（乐观锁）后局部刷新 */
  async function markMastered(agent: string, recordId: string, version: number): Promise<void> {
    await k12MarkMastered({ agent, record_id: recordId, version })
    await loadMistakes(agent)
  }

  /** 学情报告（真实端点，替代客户端聚合） */
  async function loadReport(agent: string): Promise<void> {
    const request = ++reportRequest
    error.value = null
    report.value = null
    try {
      const next = await k12InsightReport(agent)
      if (request === reportRequest) report.value = next
    } catch (e) {
      if (request !== reportRequest) return
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 学习时长（一维按日） */
  async function loadStudyTime(agent: string): Promise<void> {
    const request = ++studyTimeRequest
    error.value = null
    studyTime.value = null
    try {
      const next = await k12StudyTime(agent)
      if (request === studyTimeRequest) studyTime.value = next
    } catch (e) {
      if (request !== studyTimeRequest) return
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 积累本（语/英）；subject 可选，触达后端分科过滤（BUG-3）。 */
  // 积累型 entry_type（镜像后端 accumKeepTypes）——「积累」tab 只显这些；纠错型（默写错/错词/语法改错）
  // 属客观错误、进「错题」tab 的复习队列（PRD §3.5.4 口径）。
  const ACCUM_KEEP_TYPES = new Set(['好词好句', '古诗', '语法点', '作文'])

  async function loadAccumulation(agent: string, subject?: string): Promise<void> {
    const request = ++accumulationRequest
    error.value = null
    accumView.value = null
    try {
      const res = await k12ListAccumulation(agent, subject)
      if (request !== accumulationRequest) return
      // 「积累」tab 只留积累型；纠错型（听写/默写/改错）已在「错题」tab 的跨科复习队列呈现。
      const keepOnly = res.items.filter((it) => ACCUM_KEEP_TYPES.has(it.entry_type))
      accumView.value = accumToView(agent, keepOnly)
    } catch (e) {
      if (request !== accumulationRequest) return
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 备课卡（事件驱动生成，非每日 cron）。
   *  状态独立（BUG-20260712-S）：不写共享 loading/error——此前 prep-card 的失败/中止
   *  （如切 tab 导致的 fetch abort）会把红字错误漏进错题本页（读共享 error 渲染）。 */
  const prepLoading = ref(false)
  const prepError = ref<string | null>(null)
  async function loadPrepCard(agent: string, grade: string, knowledgePoints?: string[]): Promise<void> {
    prepLoading.value = true
    prepError.value = null
    try {
      prepCard.value = await k12PrepCard({ agent, grade, knowledge_points: knowledgePoints })
    } catch {
      // 治本（BUG-20260712）：k12PrepCard 失败时 e.message 是裸技术串（「[POST] … Load failed」/
      // 「Fetch is aborted」），家长看不懂且吓人。统一翻成可操作的本地化提示（超时/网络中断 → 请重试 +
      // 慢本地模型可切云端）。原始错误对家长无价值，故不透出裸串。
      prepError.value = i18n.global.t('k12.prep.generateFailed')
    } finally {
      prepLoading.value = false
    }
  }

  /** 批改一道题 → 验算徽章数据 + 是否入库 */
  async function grade(req: GradeReq): Promise<GradeViewResult> {
    const resp = await k12Grade(req)
    return gradeToResult(resp)
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

  /**
   * 拍题识题：作业图片 → 题目清单 + 整卷学科（识题回显护栏的第一步，需 LLM）。
   * 返回整卷 subject 供护栏预填学科下拉（家长不必手选，仍可手动覆盖，Polish-2）。
   */
  async function recognize(imageBase64: string): Promise<RecognizeResp> {
    loading.value = true
    error.value = null
    try {
      const resp = await k12Recognize(imageBase64)
      return { questions: resp.questions, subject: resp.subject ?? '' }
    } finally {
      loading.value = false
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
    mistakeView, accumView, report, studyTime, prepCard, prepLoading, prepError, loading, error,
    loadMistakes, markMastered, loadPrepCard, loadReport, loadStudyTime, loadAccumulation, grade, solve,
    recognize, coldStart, tutorTurn, setupAutomation,
  }
})

/** 后端 501（未注入 cron/router，如非桌面运行时）→ 自动化是增强项，静默降级不阻断建档。 */
function isNotImplemented(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('501') || msg.includes('未注入')
}
