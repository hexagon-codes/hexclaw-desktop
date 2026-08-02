import {
  assertK12ImageTaskCreateResponse,
  assertK12ImageTaskDispatchResponse,
  assertK12ImageTaskProblemSourceActionResponse,
  assertK12ImageTaskResultResponse,
} from '@/contracts/generated/k12-image-task.v1'
import type { K12ImageTaskProblemSourceActionResponse } from '@/contracts/generated/k12-image-task.v1'
import {
  assertImageTaskProblemSourceActionSemantics,
  assertImageTaskResultSemantics,
  normalizeImageTaskDispatchEnvelope,
  normalizeImageTaskProblemSourceActionSnapshot,
} from '@/contracts/k12-image-task-semantics'
/**
 * K12 家长辅导助手后端契约（/api/k12/*）。
 * DTO 与后端 scenarios/k12/apihttp/handler.go 的 json tag 1:1 对齐（前端类型即契约）。
 *
 * 注意：K12 端点**不需要 user_id**，隔离键是 `agent`（= agents.name）。
 * 错误响应统一 {error: string}（语言不保证），由 client.ts normalizeApiError 提到 e.message。
 */
import { api, apiGet, apiPost, apiPut, apiDelete } from './client'
import { env } from '@/config/env'
import { DESKTOP_USER_ID } from '@/constants'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'
import { isTauri } from '@/utils/platform'
import {
  createNativeFileOperation,
  stageBlob,
  uploadGrantedFile,
  type NativeFileGrant,
} from './native-files'

const BASE = '/api/k12'

// ── view-descriptor ──────────────────────────────────────────
/** 后端扁平视图描述符（GET /api/k12/view-descriptor?slot=tutor） */
export interface ViewDescriptorDTO {
  header_tabs: string[]
  message_badges: string[]
  composer_placeholder: string
  /** composer 预设 chips（后端已下发；前端从此渲染，不硬编码场景 chip · AP-1） */
  composer_chips?: string[]
  record_collections: string[]
  side_panels: string[]
  actions: string[]
  i18n_keys: string[]
  schema_version: number
}

export function k12GetViewDescriptor(slot = 'tutor') {
  return apiGet<ViewDescriptorDTO>(`${BASE}/view-descriptor`, { slot })
}

// ── grade（批改一道题，核心闭环）─────────────────────────────
export interface GradeReq {
  agent: string
  subject?: string
  grade: string
  source_session?: string
  problem: string
  student_answer?: string
  knowledge_points?: string[]
}

/** verdict 判定五值（§4.5 布尔 correct 已删除）：批改路径 = 批改判定（agree=答对 /
 *  disagree=答错）；解题分叉/超纲沿用验算/超纲结论；verbatim = 语英原词重现确定性比对。 */
export type GradeVerdict = 'agree' | 'disagree' | 'unverifiable' | 'out_of_scope' | 'verbatim'
/** 徽章枚举（后端 usecase/evidence.go Badge()） */
export type GradeBadge =
  | 'verified-strong'
  | 'verified-weak'
  | 'disagree'
  | 'out-of-scope'
  | 'unverifiable'
  | 'verbatim-recall'
export type EvidenceType =
  | 'numeric_exec'
  | 'symbolic_exec'
  | 'heterogeneous_model'
  | 'heuristic'
  | 'verbatim'
  | 'none'

export interface GradeResp {
  solution: string
  /** 批改判定五值口径（agree=答对/disagree=答错）；布尔 correct 字段已随后端契约删除。 */
  verdict: GradeVerdict
  evidence_type: EvidenceType
  badge: GradeBadge
  wrong_step?: string
  error_cause?: string
  out_of_scope: boolean
  out_of_scope_kp?: string
  record_created: boolean
  record_id?: string
  /** 课程词表暂未映射的知识点；仅作 fail-visible 证据，不等同超纲。 */
  curriculum_unmapped?: string[]
  /** true = student_answer 为空，后端内部转「解题」分叉（非批改）：只给 solution，
   *  无批改判定与入库。前端应按解题口径呈现，不显对/错、不显入本。 */
  solve_only?: boolean
}

export function k12Grade(req: GradeReq) {
  // 真实整卷 3 路并发时个别 solver+verifier 实测会略超 120s；留 240s 给排队与 grader，
  // 避免后端已成功而桌面先 abort、整卷按钮永远残留（BUG-20260714）。
  return apiPost<GradeResp>(`${BASE}/grade`, req, { timeout: 240_000 })
}

// ── record-mistake（记一条错题：家长手动录入的**已知错题**，轻量直录，不跑验算链）──────
// 与 /grade 的分工：/grade 是「不知道对不对」→ 跑对抗验算链判对错（1-2 分钟）；
// /record-mistake 是「已经知道错了」→ 直接入错题本 + 单次轻量错因归纳，秒级完成。
export interface RecordMistakeReq {
  agent: string
  subject?: string
  grade: string
  source_session?: string
  problem: string
  /** 孩子的答案 / 错处（选填） */
  student_answer?: string
  /** 家长填的错因（选填，留空由后端单次轻量归纳） */
  error_cause?: string
  knowledge_points?: string[]
}
export interface RecordMistakeResp {
  /** 是否新入库（false=幂等去重命中同题） */
  record_created: boolean
  record_id?: string
  /** 最终落库错因（用户填 / 轻量归纳 / 空） */
  error_cause?: string
}
/** 「记一条错题」：直接入错题本（不跑 solve+verify 对抗验算链）。轻量单次调用，30s 足够。 */
export function k12RecordMistake(req: RecordMistakeReq) {
  return apiPost<RecordMistakeResp>(`${BASE}/record-mistake`, req, { timeout: 30_000 })
}

// ── solve（空白/未作答题求解：给解法+答案+讲解，不批改、不入错题本）──────────
// 单一真相源分叉的「空白卷」端点：识题回收的 student_answer 为空 → 走此端点求解，
// 不要求家长填答案，绝不触发批改路径的 grade_correct 缺失 502（治本）。
export interface SolveReq {
  agent: string
  subject?: string
  grade: string
  problem: string
  knowledge_points?: string[]
}
export interface SolveResp {
  solution: string
  verdict: GradeVerdict
  evidence_type: EvidenceType
  badge: GradeBadge
  out_of_scope: boolean
  out_of_scope_kp?: string
}
export function k12Solve(req: SolveReq) {
  // 解题与 grade 使用同一 solver+verifier 链，使用相同的并发排队预算。
  return apiPost<SolveResp>(`${BASE}/solve`, req, { timeout: 240_000 })
}

// ── mistakes / review-queue（错题本）─────────────────────────
export interface MistakeDTO {
  record_id: string
  question: string
  knowledge_point: string
  error_cause: string
  status: string
  /** 复习调度唯一状态；v57 起替代旧 status/archive 的复习语义。 */
  review_state?: 'scheduled' | 'deferred_this_week' | 'suppressed' | 'mastered'
  version: number
  /** 到期 unix 秒（omitempty，可缺省/为 null） */
  due_at?: number | null
  /** 跨科复习队列：学科（数学/语文/英语），后端 review-queue 下发；/mistakes 列表可缺省 */
  subject?: string
  /** 再练方式：verify=验算链变式（数理化）/ verbatim=原词重现字符比对（语英字词） */
  review_kind?: string
  /** 抽查复验状态（§3.6：none/scheduled/passed/failed）。前端只消费 failed →
   *  详情「家长确认（复验未过）」事实标注；scheduled 不呈现（不打抽查标签）。 */
  spot_check_state?: string
  /** 家长主观确认时间；不等于系统掌握证据。 */
  parent_confirmed_at?: number
  /** 当前软归档事实；恢复后清空，历史审计保存在服务端归档快照。 */
  archived_reason?: string
  archived_at?: number
  archive_restored_at?: number
  /** 服务端确认存在可恢复快照；legacy archived 不得由客户端猜测可恢复。 */
  restorable?: boolean
}

export interface MistakesResp {
  items: MistakeDTO[]
}

/** 错题本列表（agent 必填；status 可选过滤） */
export function k12ListMistakes(agent: string, status?: string) {
  return apiGet<MistakesResp>(`${BASE}/mistakes`, status ? { agent, status } : { agent })
}

/** 到期复习队列（due_at <= now，按 due_at 升序） */
export function k12ReviewQueue(agent: string) {
  return apiGet<MistakesResp>(`${BASE}/review-queue`, { agent })
}

// ── delete mistake（UX-3 数据纠错：移除记错/重复条目，非逃避难题）────────────
/** 删除一条错题（DELETE /mistakes/{record_id}?agent=）。后端按 agent 归属校验，越权/不存在 → 404。 */
export function k12DeleteMistake(agent: string, recordId: string) {
  return apiDelete<{ ok: boolean }>(
    `${BASE}/mistakes/${encodeURIComponent(recordId)}?agent=${encodeURIComponent(agent)}`,
  )
}

// ── mistake review commands（BUG-20260725-013/017）────────
export interface MistakeReviewCommandReq {
  agent: string
  version: number
  idempotency_key: string
}

/** 「不再复习」：长期排除，但不产生掌握证据。 */
export function k12SuppressMistake(
  agent: string,
  recordId: string,
  version: number,
  idempotencyKey: string,
) {
  return apiPost<MistakeDTO>(`${BASE}/mistakes/${encodeURIComponent(recordId)}/suppress`, {
    agent,
    version,
    idempotency_key: idempotencyKey,
  })
}

/** 成功 Undo 与「不再复习」筛选中的恢复共用唯一 restore。 */
export function k12RestoreMistakeReview(
  agent: string,
  recordId: string,
  version: number,
  idempotencyKey: string,
) {
  return apiPost<MistakeDTO>(`${BASE}/mistakes/${encodeURIComponent(recordId)}/restore-review`, {
    agent,
    version,
    idempotency_key: idempotencyKey,
  })
}

/** @deprecated 仅供旧调用方编译迁移；语义与路由均已切到 suppress/restore-review。 */
export const k12ArchiveMistake = k12SuppressMistake
/** @deprecated 仅供旧调用方编译迁移；新代码使用 k12RestoreMistakeReview。 */
export const k12RestoreMistake = k12RestoreMistakeReview

export interface DeferMistakeThisWeekReq {
  agent: string
  version: number
  plan_id: string
  plan_revision: number
  weekly_item_id: string
  iso_year: number
  iso_week: number
  idempotency_key: string
}

/** 「本周先不练」只影响当前 ISO 周，不写 mastered/suppressed。 */
export function k12DeferMistakeThisWeek(recordId: string, req: DeferMistakeThisWeekReq) {
  return apiPost<{ state: 'deferred_this_week'; replayed: boolean }>(
    `${BASE}/mistakes/${encodeURIComponent(recordId)}/defer-this-week`,
    req,
  )
}

// ── mark-mastered（他会了，乐观锁）───────────────────────────
export interface MarkMasteredReq {
  agent: string
  record_id: string
  version: number
}

/** 409 版本冲突时 client 抛错（e.message = "record version conflict"） */
export function k12MarkMastered(req: MarkMasteredReq) {
  return apiPost<{ ok: boolean }>(`${BASE}/mark-mastered`, req)
}

// ── 错题候选选择（生成与入集两阶段；BUG-20260725-010/011）────────────
export type PracticeCandidateState = 'generating' | 'ready' | 'failed' | 'already_in_set'
export type PracticeCandidateKind = 'original' | 'variant'

export interface PracticeCandidateDTO {
  candidate_id: string
  candidate_kind: PracticeCandidateKind
  batch_ordinal: number
  candidate_ordinal: number
  normalized_content_hash: string
  state: PracticeCandidateState
  question_markdown: string
  expected_answer_markdown?: string
  failure_message?: string
}

export interface PracticeCandidateSelectionDTO {
  selection_id: string
  source_mistake_id: string
  target_set_record_id: string
  state: 'open' | 'committed'
  next_batch_ordinal: number
  revision: number
  candidates: PracticeCandidateDTO[]
}

export interface OpenPracticeCandidateSelectionReq {
  agent: string
  idempotency_key: string
  grade?: string
  textbook?: string
  provider?: string
  model?: string
  source_session?: string
}

export function k12OpenPracticeCandidateSelection(
  recordId: string,
  req: OpenPracticeCandidateSelectionReq,
) {
  if (Boolean(req.provider) !== Boolean(req.model)) {
    throw new Error('候选题模型路由必须同时包含供应商和模型')
  }
  return apiPost<PracticeCandidateSelectionDTO>(
    `${BASE}/mistakes/${encodeURIComponent(recordId)}/practice-candidate-selection`,
    req,
  )
}

export function k12GeneratePracticeCandidateBatch(
  selectionId: string,
  req: {
    agent: string
    revision: number
    idempotency_key: string
    provider?: string
    model?: string
  },
) {
  if (Boolean(req.provider) !== Boolean(req.model)) {
    throw new Error('候选题模型路由必须同时包含供应商和模型')
  }
  return apiPost<PracticeCandidateSelectionDTO>(
    `${BASE}/practice-candidate-selections/${encodeURIComponent(selectionId)}/batches`,
    req,
  )
}

export interface CommitPracticeCandidateSelectionResp {
  selection: PracticeCandidateSelectionDTO
  added_count: number
  already_present: string[]
  replayed: boolean
}

export function k12CommitPracticeCandidateSelection(
  selectionId: string,
  req: {
    agent: string
    revision: number
    candidate_ids: string[]
    idempotency_key: string
  },
) {
  return apiPost<CommitPracticeCandidateSelectionResp>(
    `${BASE}/practice-candidate-selections/${encodeURIComponent(selectionId)}/commit`,
    req,
  )
}

// ── 旧错题一键生成投影（只读兼容；新入口不得调用）────────────────────
export type MistakePracticeGenerationState =
  | 'available'
  | 'pending'
  | 'joined'
  | 'failed'
  | 're_add'
  | 'hidden'

export interface MistakePracticeGenerationDTO {
  state: MistakePracticeGenerationState
  source_mistake_id: string
  generation_job_id?: string
  practice_set_id?: string
  practice_item_id?: string
  failure_reason?: string
  source_mistake_summary?: string
  item?: PracticeItemDTO
  parent_confirmed?: boolean
  evidence_mastered?: boolean
}

export interface StartMistakePracticeGenerationReq {
  agent: string
  /** 路径参数，不进入请求体。 */
  record_id: string
  idempotency_key: string
  grade?: string
  textbook?: string
  difficulty?: 'same' | 'easier' | 'harder'
  provider?: string
  model?: string
  source_session?: string
}

/**
 * 一次点击只创建一个可恢复的服务端任务；生成、验证与装篮均由后端协调器完成。
 * 显式路由必须成对冻结，避免界面所示模型与实际任务模型漂移。
 */
export function k12StartMistakePracticeGeneration(req: StartMistakePracticeGenerationReq) {
  if (Boolean(req.provider) !== Boolean(req.model)) {
    throw new Error('逐题出题模型路由必须同时包含供应商和模型')
  }
  const { record_id: recordID, ...body } = req
  return apiPost<MistakePracticeGenerationDTO>(
    `${BASE}/mistakes/${encodeURIComponent(recordID)}/practice-generation`,
    body,
  )
}

/** 列表与重启恢复只读服务端投影，不依赖组件内存成功标记。 */
export function k12GetMistakePracticeGeneration(agent: string, recordID: string) {
  return apiGet<MistakePracticeGenerationDTO>(
    `${BASE}/mistakes/${encodeURIComponent(recordID)}/practice-generation`,
    { agent },
  )
}

/** 失败重试复用原 generation job / item，占位题不会重复创建。 */
export function k12RetryMistakePracticeGeneration(agent: string, recordID: string) {
  return apiPost<MistakePracticeGenerationDTO>(
    `${BASE}/mistakes/${encodeURIComponent(recordID)}/practice-generation/retry`,
    { agent },
  )
}

// ── tutoring-tips（辅导要点，固定三段）─────────────────────────────
export interface TutoringTipsReq {
  agent: string
  /** 已由家长确认并冻结 canonical 输入的当前图片任务；服务端负责解析内部批改实体。 */
  dispatch_id: string
}

/** source_label 只承载原型三类来源：📖 依据课本 / 🧠 学情信号 / 🤖 AI 归纳·供参考。 */
export interface TutoringTipsSectionDTO {
  title: string
  content: string
  source_label: string
}

export interface TutoringTipsResp {
  knowledge_points: string[]
  sections: [TutoringTipsSectionDTO, TutoringTipsSectionDTO, TutoringTipsSectionDTO]
}

const TUTORING_TIPS_SOURCE_LABELS = new Set(['📖 依据课本', '🧠 学情信号', '🤖 AI 归纳·供参考'])

function assertTutoringTipsResp(value: unknown): asserts value is TutoringTipsResp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid tutoring tips response')
  }
  const response = value as Record<string, unknown>
  const keys = Object.keys(response).sort()
  if (keys.length !== 2 || keys[0] !== 'knowledge_points' || keys[1] !== 'sections') {
    throw new Error('invalid tutoring tips response fields')
  }
  if (
    !Array.isArray(response.knowledge_points) ||
    !response.knowledge_points.every((item) => typeof item === 'string') ||
    !Array.isArray(response.sections) ||
    response.sections.length !== 3
  ) {
    throw new Error('invalid tutoring tips response shape')
  }

  const sections = response.sections as unknown[]
  for (const section of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error('invalid tutoring tips section')
    }
    const record = section as Record<string, unknown>
    const sectionKeys = Object.keys(record).sort()
    if (
      sectionKeys.length !== 3 ||
      sectionKeys[0] !== 'content' ||
      sectionKeys[1] !== 'source_label' ||
      sectionKeys[2] !== 'title' ||
      typeof record.title !== 'string' ||
      typeof record.content !== 'string' ||
      typeof record.source_label !== 'string' ||
      !TUTORING_TIPS_SOURCE_LABELS.has(record.source_label)
    ) {
      throw new Error('invalid tutoring tips section fields')
    }
    if (/热身|warm[ -]?up/i.test(`${record.title}\n${record.content}`)) {
      throw new Error('invalid tutoring tips warm-up section')
    }
  }
  const titles = sections.map((section) => (section as TutoringTipsSectionDTO).title.trim())
  if (
    titles[0] !== '这页在练什么' ||
    !titles[1]?.endsWith('要留意') ||
    titles[2] !== '每道题怎么带（不直接给答案）'
  ) {
    throw new Error('invalid tutoring tips section order')
  }
}

export async function k12TutoringTips(req: TutoringTipsReq, signal?: AbortSignal) {
  const body: TutoringTipsReq = {
    agent: req.agent.trim(),
    dispatch_id: req.dispatch_id.trim(),
  }
  if (!body.agent || !body.dispatch_id) throw new Error('untrusted tutoring tips scope')
  // LLM 生成辅导要点，默认 30s 会腰斩→「Fetch is aborted」（BUG-20260712-T1 真机取证）
  const response = await apiPost<unknown>(`${BASE}/tutoring-tips`, body, {
    timeout: 120_000,
    signal,
  })
  assertTutoringTipsResp(response)
  return response
}

// ── insight-report（学情报告）────────────────────────────────
// study-time API 已删除（架构设计 v0.5.0《明确不做》#6：不做学习时长与无证据投入指标）。
/** reviewing = new + explained（待复习） */
export interface TrendCounts {
  mastered: number
  reviewing: number
  retried: number
  archived: number
  total: number
}
export interface WeakPoint {
  subject: string
  knowledge_point: string
  count: number
  /** 当前月新增错题内的占比；由服务端同一快照计算。 */
  share: number
}
export interface InsightReportResp {
  learner: string
  grade_term: string
  as_of: number
  source_digest: string
  source_record_ids: string[]
  unscoped_source_count: number
  review_week_start: number
  review_week_end: number
  trend: TrendCounts
  weak_top3: WeakPoint[]
  month_new_mistakes: number
  week_pending: number
  practice_pending: number
  /** -1 = 分母为 0 的哨兵，前端显示「—」 */
  review_completion_rate: number
  /** 连续挫败知识点；可能为 JSON null */
  consecutive_fail_kps: string[] | null
  suggestion: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
}
export function k12InsightReport(agent: string) {
  return apiGet<InsightReportResp>(`${BASE}/insight-report`, { agent })
}

// ── profile（孩子档案，GET/PUT；存 agent metadata k12.*）──────
export type K12TextbookSubject =
  | 'math'
  | 'chinese'
  | 'english'
  | 'science'
  | 'information_technology'
  | 'art'

export type SubjectTextbooksDTO = Record<K12TextbookSubject, string>

/** subject_textbooks 是唯一可写教材真相；textbook_edition 是服务端派生的数学只读镜像。 */
export interface ProfileDTO {
  child_name: string
  grade_term: string
  subject_textbooks: SubjectTextbooksDTO
  textbook_edition: string
}
export interface UpdateProfileReq {
  agent: string
  child_name?: string
  grade_term?: string
  textbook_edition?: string
}
// 注：GET /profile 的前端客户端已删除——档案在前端从 agent.metadata(k12.*) 读取（确定性注入通道），
// 无需单独拉档案端点（审计 #8 冗余死绑定清理）。后端 GET /profile 仍存（其它用途/联调）。
export function k12UpdateProfile(req: UpdateProfileReq) {
  return apiPut<ProfileDTO>(`${BASE}/profile`, req)
}

// ── weekly practice（本周该练；教材进度、三轨计划与同源输出）────────
export interface CurriculumCatalogLessonDTO {
  lesson_id: string
  title: string
  page_from: number
  page_to: number
}

export interface CurriculumCatalogUnitDTO {
  unit_id: string
  title: string
  page_from: number
  page_to: number
  lessons: CurriculumCatalogLessonDTO[]
}

export interface CurriculumCatalogDTO {
  agent: string
  subject: 'math'
  textbook_binding_id: string
  textbook_manifest_id: string
  document_id: string
  document_generation: number
  textbook_edition: string
  textbook_version: string
  title: string
  volume: string
  page_min: number
  page_max: number
  units: CurriculumCatalogUnitDTO[]
}

export interface TextbookManifestPageRefDTO {
  logical_page: number
  pdf_page: number
  segment_refs: string[]
}

export interface TextbookManifestCatalogDTO {
  subject: 'math'
  textbook_edition: string
  textbook_version: string
  title: string
  volume: string
  page_min: number
  page_max: number
  units: CurriculumCatalogUnitDTO[]
  page_refs: TextbookManifestPageRefDTO[]
}

export type TextbookManifestState =
  | 'waiting_ingest'
  | 'extracting'
  | 'ready_for_confirmation'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'stale'

export interface TextbookBindingOptionDTO {
  manifest_id: string
  document_id: string
  document_generation: number
  document_title: string
  state: TextbookManifestState
  retryable: boolean
  failure_message: string
  text_index_state: string
  vector_index_state: string
  catalog: TextbookManifestCatalogDTO | null
  updated_at: string
}

export interface TextbookBindingOptionsResp {
  items: TextbookBindingOptionDTO[]
}

export type CurriculumPageVerificationStatus =
  | 'not_requested'
  | 'verified'
  | 'partially_verified'
  | 'rejected'

export interface CurriculumProgressDTO {
  progress_id: string
  agent: string
  subject: 'math'
  revision: number
  textbook_binding_id: string
  textbook_manifest_id: string
  textbook_edition: string
  textbook_version: string
  title: string
  volume: string
  unit_id: string
  unit_title: string
  lesson_id?: string
  lesson_title?: string
  requested_page_from?: number
  requested_page_to?: number
  verified_page_from?: number
  verified_page_to?: number
  page_verification_status: CurriculumPageVerificationStatus
  segment_refs: string[]
  evidence_source: string
  confirmed_at: string
  created_at: string
  updated_at: string
}

export interface CurriculumProgressResp {
  progress: CurriculumProgressDTO | null
}

export interface WeeklyPracticeSettingsDTO {
  agent: string
  revision: number
  timezone: string
  due_review_enabled: true
  textbook_consolidation_enabled: boolean
  textbook_consolidation_tier: WeeklyTextbookConsolidationTier
  arithmetic_warmup_enabled: boolean
  arithmetic_minutes: number
  created_at: string
  updated_at: string
}

export interface ProfileBundleProfileDTO extends ProfileDTO {
  revision: number
}

export interface UpdateProfileBundleReq {
  agent: string
  idempotency_key: string
  expected_profile_revision: number
  expected_progress_revision: number
  expected_settings_revision: number
  agent_config: {
    display_name: string
    description: string
    system_prompt: string
    provider: string
    model: string
    skills: string[]
  }
  profile: {
    child_name: string
    grade_term: string
    subject_textbooks: SubjectTextbooksDTO
  }
  curriculum_progress: {
    subject: 'math'
    textbook_manifest_id: string
    volume: string
    unit_id: string
    lesson_id?: string
    page_from?: number
    page_to?: number
    evidence_source: 'parent_confirmed'
  }
  weekly_practice_settings: {
    timezone: string
    textbook_consolidation_enabled: boolean
    textbook_consolidation_tier: WeeklyTextbookConsolidationTier
    arithmetic_warmup_enabled: boolean
    arithmetic_minutes: number
  }
}

export interface ProfileBundleResp {
  agent_config: UpdateProfileBundleReq['agent_config']
  profile: ProfileBundleProfileDTO
  curriculum_progress: CurriculumProgressDTO
  weekly_practice_settings: WeeklyPracticeSettingsDTO
  replayed: boolean
}

export type WeeklyPracticeSection = 'due_review' | 'textbook_consolidation' | 'arithmetic_warmup'
export type WeeklyPracticeTrackStatus = 'ready' | 'disabled' | 'failed' | 'stale'
export type WeeklyPracticePlanStatus = 'draft' | 'frozen' | 'archived' | 'expired_unused'
export type WeeklyManualTrackAvailability =
  | 'available'
  | 'setup_required'
  | 'processing'
  | 'failed_retryable'
  | 'failed_terminal'
export type WeeklyTextbookConsolidationTier = 'less' | 'standard' | 'more'
export type WeeklyPracticeGenerationMethod =
  | 'original'
  | 'ai_variant'
  | 'ai_generated'
  | 'rule_generated'

export interface WeeklyPracticeItemVerificationDTO {
  status: 'verified' | 'failed'
  evidence_refs: string[]
  textbook_binding_id?: string
  unit_id?: string
  lesson_id?: string
  verified_page_from?: number
  verified_page_to?: number
}

export interface WeeklyPracticeItemDTO {
  item_id: string
  position: number
  plan_section: WeeklyPracticeSection
  source_kind: string
  generation_method: WeeklyPracticeGenerationMethod
  source_ref: string
  verification: WeeklyPracticeItemVerificationDTO
  prompt_markdown: string
}

export type WeeklyArithmeticBatchState =
  | 'preparing'
  | 'ready'
  | 'in_progress'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'

export interface WeeklyArithmeticBatchDTO {
  batch_id: string
  state: WeeklyArithmeticBatchState
  item_count: number
  content_digest: string
  retryable: boolean
  failure_message: string
  created_at: string
  updated_at: string
  completed_at?: string
}

export interface WeeklyPracticeTrackDTO {
  plan_section: WeeklyPracticeSection
  status: WeeklyPracticeTrackStatus
  failure_message?: string
  items: WeeklyPracticeItemDTO[]
  arithmetic_batch: WeeklyArithmeticBatchDTO | null
}

export interface WeeklyManualTrackRecommendationDTO {
  availability: WeeklyManualTrackAvailability
  selected_item_count: number
  recommended_item_count: number
  min_item_count: number
  max_item_count: number
}

export interface WeeklyManualTrackRecommendationsDTO {
  textbook_consolidation: WeeklyManualTrackRecommendationDTO
  arithmetic_warmup: WeeklyManualTrackRecommendationDTO
}

export interface WeeklyPracticePlanDTO {
  plan_id: string
  agent: string
  revision: number
  iso_week_year: number
  iso_week_number: number
  timezone: string
  week_start: string
  week_end: string
  local_start_date: string
  local_end_date: string
  status: WeeklyPracticePlanStatus
  settings_revision: number
  curriculum_progress_revision?: number
  tracks: WeeklyPracticeTrackDTO[]
  manual_track_recommendations: WeeklyManualTrackRecommendationsDTO
  created_at: string
  updated_at: string
}

export interface WeeklyPracticePlanResp {
  plan: WeeklyPracticePlanDTO
  replayed: boolean
}

export interface WeeklyPracticeCurrentResp {
  plan: WeeklyPracticePlanDTO | null
}

export interface WeeklyPracticeSnapshotDTO {
  snapshot_id: string
  artifact_id: string
  plan_id: string
  plan_revision: number
  agent: string
  iso_week_year: number
  iso_week_number: number
  timezone: string
  week_start: string
  week_end: string
  local_start_date: string
  local_end_date: string
  settings_revision: number
  curriculum_progress_revision?: number
  tracks: WeeklyPracticeTrackDTO[]
  render_version: string
  snapshot_digest: string
  created_at: string
}

export interface WeeklyPracticeHistorySummaryDTO {
  snapshot_id: string
  artifact_id: string
  plan_id: string
  iso_week_year: number
  iso_week_number: number
  timezone: string
  local_start_date: string
  local_end_date: string
  item_count: number
  correct_count: number
  wrong_count: number
  needs_review_count: number
  archived_at: string
}

export interface WeeklyPracticeHistoryResp {
  items: WeeklyPracticeHistorySummaryDTO[]
  next_cursor: string | null
}

export interface PrintableArtifactDTO {
  artifact_id: string
  source_kind: GenericPrintSourceKind
  source_ref: string
  title: string
  source_digest: string
  format: string
  render_contract_version: string
  content_type: string
  byte_digest: string
  byte_size: number
}

export interface WeeklyPracticePrepareOutputResp {
  snapshot: WeeklyPracticeSnapshotDTO
  artifact: PrintableArtifactDTO
}

export interface WeeklyPracticeAttemptDTO {
  attempt_id: string
  snapshot_id: string
  item_id: string
  assessment_id: string
  result: 'correct' | 'wrong' | 'needs_review'
  verification_evidence: unknown
  mistake_record_id?: string
  review_scheduled: boolean
  created_at: string
}

export interface WeeklyPracticeAttemptResp {
  attempt: WeeklyPracticeAttemptDTO
  replayed: boolean
}

export interface WeeklyArithmeticAttemptDTO {
  attempt_id: string
  batch_id: string
  item_id: string
  assessment_id: string
  result: 'correct' | 'wrong' | 'needs_review'
  verification_evidence: unknown
  mistake_record_id?: string
  review_scheduled: boolean
  created_at: string
}

export interface WeeklyArithmeticAttemptResp {
  attempt: WeeklyArithmeticAttemptDTO
  replayed: boolean
}

export interface WeeklyArithmeticBatchResp {
  batch: WeeklyArithmeticBatchDTO
  replayed: boolean
}

export interface WeeklyPracticeSaveReceiptDTO {
  save_receipt_id: string
  plan_id: string
  plan_revision: number
  snapshot_id: string
  practice_set_id: string
  created_at: string
}

export interface WeeklyPracticeSaveResp {
  receipt: WeeklyPracticeSaveReceiptDTO
  replayed: boolean
}

export function k12GetCurriculumCatalog(agent: string, textbookEdition: string, volume: string) {
  return apiGet<CurriculumCatalogDTO>(`${BASE}/curriculum-catalog`, {
    agent,
    subject: 'math',
    textbook_edition: textbookEdition,
    volume,
  })
}

export function k12GetCurriculumProgress(agent: string) {
  return apiGet<CurriculumProgressResp>(`${BASE}/curriculum-progress`, {
    agent,
    subject: 'math',
  })
}

export function k12GetTextbookBindingOptions(agent: string) {
  return apiGet<TextbookBindingOptionsResp>(`${BASE}/textbook-binding-options`, {
    agent,
    subject: 'math',
  })
}

export function k12GetWeeklyPracticeSettings(agent: string) {
  return apiGet<WeeklyPracticeSettingsDTO>(`${BASE}/weekly-practice/settings`, { agent })
}

export function k12UpdateProfileBundle(req: UpdateProfileBundleReq) {
  return apiPut<ProfileBundleResp>(`${BASE}/profile-bundle`, req)
}

export function k12EnsureWeeklyPracticePlan(agent: string, idempotencyKey: string) {
  return apiPost<WeeklyPracticePlanResp>(`${BASE}/weekly-practice/plans`, {
    agent,
    idempotency_key: idempotencyKey,
  })
}

export function k12GetCurrentWeeklyPracticePlan(agent: string) {
  return apiGet<WeeklyPracticeCurrentResp>(`${BASE}/weekly-practice/plans/current`, { agent })
}

export function k12GetWeeklyPracticeHistory(agent: string, cursor?: string, limit = 20) {
  return apiGet<WeeklyPracticeHistoryResp>(`${BASE}/weekly-practice/plans/history`, {
    agent,
    cursor,
    limit,
  })
}

export function k12GetWeeklyPracticeSnapshot(agent: string, snapshotId: string) {
  return apiGet<WeeklyPracticeSnapshotDTO>(
    `${BASE}/weekly-practice/snapshots/${encodeURIComponent(snapshotId)}`,
    { agent },
  )
}

export function k12PrepareWeeklyPracticeOutput(
  agent: string,
  planId: string,
  expectedRevision: number,
  idempotencyKey: string,
) {
  return apiPost<WeeklyPracticePrepareOutputResp>(
    `${BASE}/weekly-practice/plans/${encodeURIComponent(planId)}/prepare-output`,
    {
      agent,
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12SendWeeklyPracticeSnapshot(
  agent: string,
  snapshotId: string,
  idempotencyKey: string,
) {
  return apiPost<DeliveryBatchDTO>(
    `${BASE}/weekly-practice/snapshots/${encodeURIComponent(snapshotId)}/send`,
    { agent, idempotency_key: idempotencyKey },
  )
}

export function k12SubmitWeeklyPracticeAttempt(
  agent: string,
  snapshotId: string,
  itemId: string,
  studentAnswer: string,
  idempotencyKey: string,
) {
  return apiPost<WeeklyPracticeAttemptResp>(
    `${BASE}/weekly-practice/snapshots/${encodeURIComponent(snapshotId)}/attempts`,
    {
      agent,
      item_id: itemId,
      student_answer: studentAnswer,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12CreateWeeklyArithmeticBatch(
  planId: string,
  planRevision: number,
  itemCount: number,
  idempotencyKey: string,
) {
  return apiPost<WeeklyArithmeticBatchResp>(
    `${BASE}/weekly-practice/plans/${encodeURIComponent(planId)}/arithmetic-batches`,
    {
      plan_revision: planRevision,
      item_count: itemCount,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12StartWeeklyArithmeticBatch(
  agent: string,
  batchId: string,
  idempotencyKey: string,
) {
  return apiPost<WeeklyArithmeticBatchResp>(
    `${BASE}/weekly-practice/arithmetic-batches/${encodeURIComponent(batchId)}/start`,
    {
      agent,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12RetryWeeklyArithmeticBatch(
  agent: string,
  batchId: string,
  idempotencyKey: string,
) {
  return apiPost<WeeklyArithmeticBatchResp>(
    `${BASE}/weekly-practice/arithmetic-batches/${encodeURIComponent(batchId)}/retry`,
    {
      agent,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12SubmitWeeklyArithmeticAttempt(
  agent: string,
  batchId: string,
  itemId: string,
  studentAnswer: string,
  idempotencyKey: string,
) {
  return apiPost<WeeklyArithmeticAttemptResp>(
    `${BASE}/weekly-practice/arithmetic-batches/${encodeURIComponent(batchId)}/attempts`,
    {
      agent,
      item_id: itemId,
      student_answer: studentAnswer,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12RefreshWeeklyPracticeTextbookTrack(
  agent: string,
  planId: string,
  expectedRevision: number,
  idempotencyKey: string,
) {
  return apiPost<WeeklyPracticePlanResp>(
    `${BASE}/weekly-practice/plans/${encodeURIComponent(planId)}/tracks/textbook_consolidation/refresh`,
    {
      agent,
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12PrepareWeeklyPracticeTextbookTrack(
  planId: string,
  planRevision: number,
  itemCount: number,
  idempotencyKey: string,
) {
  return apiPost<WeeklyPracticePlanResp>(
    `${BASE}/weekly-practice/plans/${encodeURIComponent(planId)}/tracks/textbook_consolidation/prepare`,
    {
      plan_revision: planRevision,
      item_count: itemCount,
      idempotency_key: idempotencyKey,
    },
  )
}

export function k12SaveWeeklyPracticePlanToPracticeSet(
  agent: string,
  planId: string,
  expectedRevision: number,
  idempotencyKey: string,
) {
  return apiPost<WeeklyPracticeSaveResp>(
    `${BASE}/weekly-practice/plans/${encodeURIComponent(planId)}/save-to-practice-set`,
    {
      agent,
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
    },
  )
}

// ── cold-start（冷启动首拍：按识题知识点倒查推断年级建档，PRD §3.1.4-4）──────
export interface ColdStartReq {
  agent: string
  child_name?: string
  /** 识题产出的知识点，后端倒查课标推断年级（取最晚首学） */
  knowledge_points?: string[]
  /** 推断不出时的兜底年级（可空 → 降级不注入约束） */
  fallback_grade?: string
  textbook_edition?: string
}
export interface ColdStartResp {
  child_name: string
  grade_term: string
  textbook_edition: string
  /** 年级是否由知识点倒查推断（false=用了兜底/默认） */
  inferred: boolean
  /** 是否新建档案（false=实例已有档案，未覆盖） */
  created: boolean
}
/** 冷启动建档：前端应先把推断年级回显给家长确认，再调此端点落库（§3.1.4-4）。 */
export function k12ColdStart(req: ColdStartReq) {
  return apiPost<ColdStartResp>(`${BASE}/cold-start`, req, { timeout: 60_000 })
}

// ── accumulation（语/英积累本，GET/POST）─────────────────────
export type AccumulationDictationStatus =
  | 'queued'
  | 'generating'
  | 'validating'
  | 'committed'
  | 'failed'

export interface AccumulationDictationGenerationDTO {
  generation_id: string
  status: AccumulationDictationStatus
  practice_item_id?: string
  failure_reason?: string
  attempt?: number
  updated_at?: number
}

export interface AccumDTO {
  record_id: string
  subject: string
  entry_type: string
  content: string
  source?: string
  version: number
  dictation_generation?: AccumulationDictationGenerationDTO
  /** unix 秒；引文列表收藏日期（原型 20260718 定案 acc-date），旧后端无此字段时缺省 */
  created_at?: number
}
export interface AddAccumReq {
  content: string
}
// subject 可选：给了则触达后端 GET /accumulation?subject= 过滤（语/英分科），不给取全量（BUG-3）。
export function k12ListAccumulation(agent: string, subject?: string) {
  return apiGet<{ items: AccumDTO[] }>(
    `${BASE}/accumulation`,
    subject ? { agent, subject } : { agent },
  )
}
export function k12AddAccumulation(agent: string, req: AddAccumReq, idempotencyKey: string) {
  return api<{ record_id: string; created: boolean }>(`${BASE}/accumulation`, {
    method: 'POST',
    query: { agent },
    body: { content: req.content },
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

export interface AccumulationDictationCommandResp {
  dictation_generation: AccumulationDictationGenerationDTO
}

/** 创建、重放或恢复同一条积累的 durable 默写 generation。 */
export function k12GenerateAccumulationDictation(agent: string, recordId: string) {
  return apiPost<AccumulationDictationCommandResp>(
    `${BASE}/accumulation/${encodeURIComponent(recordId)}/dictation-to-basket`,
    { agent },
  )
}
/** 将这条积累内容发送给当前辅导智能体绑定的全部有效私聊。
 *  接收人枚举、物理目标去重和目标快照全部由服务端完成。 */
export function k12SendAccumulation(agent: string, recordId: string) {
  return apiPost<DeliveryBatchDTO>(`${BASE}/accumulation/${encodeURIComponent(recordId)}/send`, {
    agent,
  })
}

export interface DeleteAccumulationReceipt {
  accumulation_id: string
  deleted: boolean
  version: number
}

/** 危险删除积累：CAS 版本与幂等键只走协议头，不进入业务 JSON。 */
export function k12DeleteAccumulation(
  agent: string,
  recordId: string,
  version: number,
  idempotencyKey: string,
) {
  return api<DeleteAccumulationReceipt>(`${BASE}/accumulation/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
    query: { agent },
    headers: {
      'If-Match': String(version),
      'Idempotency-Key': idempotencyKey,
    },
  })
}

// ── backup / restore（真实 .hexbak，服务端带 checksum）──────
export interface HexbakAsset {
  asset_id: string
  owner_agent: string
  sha256: string
  mime: string
  /** Go []byte JSON encoding: base64 content bytes, covered by the v3 checksum. */
  data: string
}
export interface HexbakCreativeWorkOCREvidence {
  job_id: string
  agent_name: string
  request_id?: string
  source_asset_id: string
  source_digest: string
  ocr_raw?: string
  version: number
  content_markdown: string
  content_digest: string
  confirmed_at: number
  attempt_count?: number
  job_created_at?: number
  job_last_updated_at?: number
}
export interface HexbakProblem {
  problem_id: string
  agent_name: string
  submission_id: string
  page_asset_id: string
  ordinal: number
  problem_kind: 'standalone' | 'compound_parent' | 'subproblem'
  parent_problem_id?: string
  subproblem_no?: string
  source_number_path?: string[]
  display_label?: string
  source_section_path?: string[]
  source_section_label?: string
  system_section_ordinal?: number
  system_display_label?: string
  subject?: string
  stem_raw: string
  stem_markdown: string
  concept_ids?: string[]
  transcription_confidence?: number
  confirmation_required?: boolean
  confirmation_reasons?: string[]
  canonical_version: number
  created_at: number
  updated_at: number
}
export interface HexbakAttemptBBox {
  x: number
  y: number
  w: number
  h: number
}
export interface HexbakAttempt {
  attempt_id: string
  agent_name: string
  submission_id: string
  problem_id: string
  answer_state: string
  answer_raw: string
  answer_markdown: string
  confirmed_version: number
  input_digest?: string
  bbox?: HexbakAttemptBBox
  created_at: number
  updated_at: number
}
export interface HexbakProblemAttemptSnapshot {
  problems: HexbakProblem[]
  attempts: HexbakAttempt[]
}
export interface HexbakArchive {
  version: number
  /** v3 content-addressed immutable archive identity; absent on compatible v1/v2 files. */
  archive_id?: string
  agent_name: string
  exported_at: number
  profile?: ProfileDTO | null
  records: unknown[]
  /** v3 content-addressed files referenced by canonical record fields. */
  assets?: HexbakAsset[]
  /** v4 confirmed-only CreativeWork OCR evidence, covered by checksum/exact-set validation. */
  creative_work_ocr?: HexbakCreativeWorkOCREvidence[]
  /** v5 canonical photographed-problem and answer snapshots, covered by checksum validation. */
  problem_attempts?: HexbakProblemAttemptSnapshot[]
  checksum: string
}
export interface K12RestoreResp {
  restored: number
  /** 服务端在写入前生成的原状态快照；可下载用于回滚。 */
  snapshot: HexbakArchive | null
}
export function k12Backup(agent: string) {
  return apiGet<HexbakArchive>(`${BASE}/backup`, { agent })
}
/** checksum 不符 → 后端 400 */
export function k12Restore(archive: HexbakArchive) {
  return apiPost<K12RestoreResp>(`${BASE}/restore`, archive as unknown as Record<string, unknown>)
}
export interface K12RestoreAsReq {
  archive: HexbakArchive
  source_agent: string
  target_agent: string
  guardian_confirmed: boolean
  idempotency_key: string
}
export interface K12RestoreAsResp {
  migration_id: string
  source_agent?: string
  target_agent: string
  status: 'completed' | 'rolled_back'
  restored: number
  original_archive_digest?: string
  migrated_checksum?: string
  snapshot_digest?: string
  journal_entries: number
  original_archive_preserved: boolean
  idempotent: boolean
  snapshot?: HexbakArchive | null
}
export function k12RestoreAs(req: K12RestoreAsReq) {
  return apiPost<K12RestoreAsResp>(`${BASE}/restore-as`, req as unknown as Record<string, unknown>)
}
export function k12RollbackRestoreAs(
  migrationId: string,
  req: { target_agent: string; guardian_confirmed: boolean },
) {
  return apiPost<K12RestoreAsResp>(
    `${BASE}/restore-as/${encodeURIComponent(migrationId)}/rollback`,
    req as unknown as Record<string, unknown>,
  )
}

// ── export / mistake-sheet（错题本导出 / 错题卷；md 返回 JSON，pdf/docx 二进制）──
export interface ExportMdResp {
  format: string
  content: string
  render_error?: string
}
export function k12ExportMd(agent: string) {
  return apiGet<ExportMdResp>(`${BASE}/export`, { agent, format: 'md' })
}
// ── render（平台 pandoc + typst 出真二进制文档：POST /api/v1/render）──────────
// 项-7：桌面端 WKWebView 里 iframe 打印失效 → 之前 PDF 兜底存成 .html。改走后端 render 端点
// 出真 .pdf。契约：请求 {content:<markdown>, format:'pdf', title?}，成功返回二进制文件流
// （Content-Type=application/pdf），失败返回 JSON {error:{...}} + 非 2xx。pandoc 读 markdown。
export interface RenderReq {
  content: string
  format: 'pdf' | 'docx' | 'html'
  title?: string
}
/** 把 Markdown 发给平台 render 服务生成二进制文档，返回 Blob（pandoc 30s / +typst PDF 60s，给足 120s）。 */
export async function renderDocument(req: RenderReq): Promise<Blob> {
  const blob = await api<Blob, 'blob'>('/api/v1/render', {
    method: 'POST',
    body: req,
    responseType: 'blob',
    timeout: 120_000,
  })
  await assertRenderedDocument(blob, req.format)
  return blob
}

/** Fail closed before a JSON/HTML error body can be saved with a PDF/DOCX extension. */
async function assertRenderedDocument(blob: Blob, format: RenderReq['format']): Promise<void> {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error(`render 返回空的 ${format.toUpperCase()} 文件`)
  }
  const mime = blob.type.toLowerCase()
  if (mime.includes('json')) {
    throw new Error(`render 返回错误 JSON，不能保存为 ${format.toUpperCase()} 文件`)
  }
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  if (format === 'pdf') {
    const pdfMagic = [0x25, 0x50, 0x44, 0x46, 0x2d]
    if (!pdfMagic.every((value, index) => bytes[index] === value)) {
      throw new Error('render 返回的 PDF 文件格式无效（缺少 %PDF- magic）')
    }
    return
  }
  if (format === 'docx') {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    if (!isZip) {
      throw new Error('render 返回的 DOCX 文件格式无效（缺少 ZIP magic）')
    }
    return
  }
  const prefix = new TextDecoder().decode(bytes).trimStart().toLowerCase()
  if (!prefix.startsWith('<!doctype') && !prefix.startsWith('<html')) {
    throw new Error('render 返回的 HTML 文件格式无效')
  }
}

// 注：GET /mistake-sheet 的前端客户端已删除——前端错题卷由客户端 printWorksheet 生成（当前视图错题
// → A4 iframe 打印），后端周错题卷 md 仅供 cron 投递用（审计 #7 冗余死绑定清理）。

// ── 图片任务公开作业投影类型（§6.7）──────────────────────────
// 两阶段直连编排 k12Recognize / k12RecognizeAnchors 已随一次切换删除
// （§6.14 链路① · 2026-07-18）：识题→锚点→批改统一走 ImageTaskDispatch facade
// （停点产物携带识别清单+整卷学科+锚点 bbox）。后端两端点已 404。
// 反向契约：src/api/__tests__/cutover-20260718-recognize-removed.test.ts。
/**
 * 学生作答区域的归一化边界框（0~1），只由独立答案锚定阶段产出，
 * 供前端在原图上叠加确定性批改标记（✓/✗）。
 * x,y=框左上角，w,h=框宽高，全部相对整图宽/高的比例（对标作业帮/小猿的「检测坐标 + 程序叠加」范式）。
 * 缺失/null = 该题未定位（视觉模型未给/坐标非法）→ 前端降级为纯文字批改，绝不叠加错位红叉。
 */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}
export type AnswerState = 'blank' | 'present' | 'unclear'
export type ProblemKind = 'standalone' | 'compound_parent' | 'subproblem'
export type OCRConfirmationReason =
  | 'fraction'
  | 'decimal_point'
  | 'negative_sign'
  | 'unit'
  | 'erasure'
  | 'evidence_conflict'
  | 'low_confidence'
  | 'unclear_handwriting'
  | 'subject_undetermined'
  | 'canonical_parse_failed'

export interface RecognizedQuestion {
  /** Submission 内稳定身份；确认、锚点和批改结果必须按 ID 关联，不能依赖返回顺序。 */
  problem_id?: string
  problem_kind?: ProblemKind
  parent_problem_id?: string
  subproblem_no?: string
  /** 原卷由大题到当前题的不可变题号 token；缺失时不得按数组位置补号。 */
  source_number_path?: string[]
  /** 原卷题号的冻结展示值。 */
  display_label?: string
  /** 原卷可见的大题标题；与题号本体分离保存。 */
  source_section_path?: string[]
  source_section_label?: string
  /** 无印刷子题号时服务端派生的显式序号，绝不等同原卷题号。 */
  system_section_ordinal?: number
  system_display_label?: string
  page_asset_id?: string
  /** compound_parent 无 Attempt；standalone/subproblem 各自拥有独立 Attempt。 */
  attempt_id?: string
  question: string
  /** OCR 原始事实不可变；canonical 只可经家长显式确认形成新版本。 */
  raw_transcription?: string
  canonical_markdown?: string
  canonical_valid?: boolean
  canonical_version?: number
  knowledge_points: string[]
  /** 作答事实的单一真相源；不允许再由答案文本或 bbox 推断。 */
  answer_state: AnswerState
  /** 识题回收的孩子手写作答；仅 present 状态应有非空值。 */
  student_answer?: string
  answer_raw_transcription?: string
  answer_canonical_markdown?: string
  answer_canonical_valid?: boolean
  /** 识题自动判定的题目学科（数学/语文/英语/物理/化学，判不出=空/缺省）。 */
  subject?: string
  /** 仅锚点阶段之后出现在公开作业投影中；核心识题永远不携带坐标。 */
  bbox?: BBox | null
  recognition_confidence?: number
  confirmation_required?: boolean
  confirmation_reasons?: OCRConfirmationReason[]
  confirmed_version?: number
  input_digest?: string
}

// ── ImageTaskDispatch（四类图片任务唯一公共 facade，§3.2/§5.4）────────────
// Desktop 只调用 /image-tasks create/get/confirm/retry/cancel/result。
// 作业子链的内部身份与路由不会暴露；Desktop 只消费以下公开投影。
export type ImageTaskHomeworkStage =
  | 'queued'
  | 'normalizing'
  | 'recognizing'
  | 'locating'
  | 'awaiting_confirmation'
  | 'assessing'
  | 'rendering'
  | 'projecting'
  | 'completed'
  | 'cancelled'
  | 'recovering'
  | 'failed_retryable'
  | 'failed_terminal'

/** 识别停点产物（awaiting_confirmation 起可用）：护栏回显数据源（含锚点 bbox）。 */
export interface ImageTaskHomeworkRecognition {
  questions: RecognizedQuestion[]
  subject?: string
}
/** 逐题批改结果（completed 后可用）；grade 复用 GradeResp wire 形状（判定五值口径）。 */
export interface PhotoJobItemDTO {
  question: RecognizedQuestion
  status:
    | 'correct'
    | 'wrong'
    | 'unanswered'
    | 'answer_unclear'
    | 'blank_solved'
    | 'out_of_scope'
    | 'untrusted'
    | 'failed'
  warning?: string
  grade?: GradeResp
  /**
   * Item-level result contract. Blank worksheets use `parent_teaching_guide`;
   * completed homework keeps its assessment projection unchanged.
   */
  result_kind: PhotoJobResultKind
  /** Complete, parent-facing guide for exactly one blank-worksheet problem. */
  parent_guide?: ParentTeachingGuideDTO
}

/** The page-level photo route frozen by the backend classifier. */
export type PhotoJobTaskIntent = 'completed_homework' | 'blank_worksheet'

/** The only approved result surface for a classified photo task. */
export type PhotoJobResultSurface = 'annotated_homework' | 'parent_teaching_guide'

/** Item-level result semantics; never infer these from legacy `mode`. */
export type PhotoJobResultKind =
  | 'assessment'
  | 'parent_teaching_guide'
  | 'unanswered'
  | 'needs_review'
  | 'out_of_scope'
  | 'failed'

/**
 * K12-INV-060 blank-worksheet contract. These seven fields are deliberately
 * parent-facing and preserve the server-provided teaching order for one exact
 * question; the UI must not synthesize them from generic grade text.
 */
export interface ParentTeachingGuideDTO {
  answer: string
  full_solution_steps: string[]
  grade_level_method: string
  likely_mistakes: string[]
  parent_teaching_sequence: string[]
  follow_up_questions: string[]
  checking_method: string
}
export interface PhotoJobResult {
  mode: 'grade' | 'solve'
  /** Product task semantics; `mode` remains only the legacy processing switch. */
  task_intent: PhotoJobTaskIntent
  /** Approved result surface selected by `task_intent`. */
  result_surface: PhotoJobResultSurface
  items: PhotoJobItemDTO[]
  markdown: string
  image_warning: string
  /**
   * 服务端基于原始作业图生成的不可变批注产物。桌面端优先直接展示该产物；
   * 老服务未返回时，才使用题目 bbox 做本地确定性叠加。
   */
  annotated_image?: {
    mime: string
    data_base64: string
    digest?: string
  }
}
export type ImageTaskIntent =
  | 'completed_homework'
  | 'blank_worksheet'
  | 'writing'
  | 'artwork'
  | 'unknown'

export type ImageTaskDispatchStatus =
  | 'routing'
  | 'awaiting_confirmation'
  | 'routed'
  | 'failed'
  | 'cancelled'

export type ImageTaskCreativeFeedbackState =
  | 'feedback_pending'
  | 'feedback_ready'
  | 'feedback_failed'
  | 'recovering'

export type ImageTaskProgressDTO =
  | { operation: 'classification'; state: ImageTaskDispatchStatus }
  | { operation: 'homework'; state: ImageTaskHomeworkStage }
  | { operation: 'writing_ocr'; state: CreativeWorkIntakeStatus }
  | {
      operation: 'promotion'
      state: CreativeWorkIntakeStatus | ImageTaskCreativeFeedbackState
    }

export interface ImageTaskHomeworkProjectionDTO {
  kind: 'homework'
  stage: ImageTaskHomeworkStage
  confirmation_state: 'pending' | 'confirmed'
  anchor_state: 'pending' | 'located' | 'degraded'
  recognition?: ImageTaskHomeworkRecognition
  structure_version?: number
  problems?: ImageTaskProblemProgressDTO[]
  coverage?: ImageTaskCoverageDTO
  projection_revision?: number
  final_artifact?: GradingFinalArtifactDTO | null
}

export interface GradingFinalArtifactDTO {
  artifact_id: string
  artifact_digest: string
  title?: string
  canonical_markdown: string
  coverage_status: 'complete' | 'with_skips'
  total_count: number
  published_count: number
  skipped_count: number
  created_at: number
  updated_at: number
}

export interface ImageTaskProblemProgressDTO {
  problem_id: string
  parent_problem_id?: string
  dependency_group_id?: string
  source_number_path: string[]
  display_label: string
  source_section_path: string[]
  source_section_label: string
  system_section_ordinal: number
  system_display_label: string
  source_state: string
  anchor_state: string
  operation_state: string
  disposition_state: string
  result_projection: Record<string, unknown> | null
  published_revision: number
  input_revision?: number
  command_available?: boolean
}

export interface ImageTaskCoverageDTO {
  state: 'full' | 'with_skips' | 'incomplete'
  total: number
  processed: number
  skipped: number
}

interface ImageTaskProblemSourceActionBaseReq {
  structure_version: number
  expected_input_revision: number
}

export type ImageTaskProblemSourceActionReq =
  | (ImageTaskProblemSourceActionBaseReq & {
      action: 'correct_text'
      payload: {
        question_canonical_markdown?: string
        answer_canonical_markdown?: string
      }
    })
  | (ImageTaskProblemSourceActionBaseReq & {
      action: 'select_region'
      payload: {
        page_asset_id: string
        region: { x: number; y: number; width: number; height: number }
      }
    })
  | (ImageTaskProblemSourceActionBaseReq & {
      action: 'retake'
      payload: { page_asset_id: string }
    })
  | (ImageTaskProblemSourceActionBaseReq & {
      action: 'skip' | 'resume'
      payload: Record<string, never>
    })

export type ImageTaskProblemSourceActionResp = K12ImageTaskProblemSourceActionResponse

export interface ImageTaskProblemSourceActionViewSnapshot {
  structure_version: number
  snapshot_revision: number
  problem_progress: ImageTaskProblemProgressDTO[]
  coverage: ImageTaskCoverageDTO
}

/**
 * Projects the compact durable source-action receipt into the existing
 * renderer DTO while retaining source labels and anchors from the current
 * view. This is the same mapper used by the GET facade projection.
 */
export function projectImageTaskProblemSourceActionSnapshot(
  response: ImageTaskProblemSourceActionResp,
  currentProblems: readonly ImageTaskProblemProgressDTO[],
): ImageTaskProblemSourceActionViewSnapshot {
  return normalizeImageTaskProblemSourceActionSnapshot(
    response,
    currentProblems,
  ) as unknown as ImageTaskProblemSourceActionViewSnapshot
}

export interface CreativeConflictDTO {
  segment_id: string
  raw_text?: string
  canonical_text?: string
  reason?: string
}

export type CreativeWorkIntakeStatus =
  | 'preparing'
  | 'awaiting_confirmation'
  | 'ready'
  | 'promoted'
  | 'failed'
  | 'cancelled'

export interface ImageTaskCreativeProjectionDTO {
  kind: 'creative'
  intake_id: string
  work_type: 'writing' | 'art'
  status: CreativeWorkIntakeStatus
  /** Hidden workflow semantics for manual archive entry; never rendered as UI copy. */
  entry_kind?: 'auto' | 'new_work'
  promotion_policy?: 'automatic' | 'explicit_commit'
  routing_provenance?: 'model_classified' | 'parent_selected'
  commit_required?: boolean
  commit_state?: 'pending' | 'committed'
  promoted_work_id?: string
  /**
   * Confirmable OCR snapshot for writing photos. This state is needed to
   * submit the smallest conflict correction, but is not itself a display
   * surface.
   */
  canonical_version?: number
  canonical_content?: string
  conflicts?: CreativeConflictDTO[]
  work?: {
    work_id: string
    display_name: string
  }
}

export type ImageTaskTargetProjectionDTO =
  | ImageTaskHomeworkProjectionDTO
  | ImageTaskCreativeProjectionDTO

export interface ImageTaskDispatchDTO {
  dispatch_id: string
  task_intent: ImageTaskIntent
  status: ImageTaskDispatchStatus
  /** Exact configured display facts frozen with new dispatch route snapshots. */
  provider_display_name?: string | null
  model_id?: string | null
  /** 服务端权威动作能力；缺失按 false 处理，客户端不得自行推断为可重试。 */
  retryable?: boolean
  automatic_budget_seconds?: number
  automatic_started_at?: number
  automatic_deadline_at?: number
  automatic_remaining_seconds?: number
  operation_deadline_at?: number
  intent_evidence: string[]
  intent_confidence: number
  confirmation_candidates: ImageTaskIntent[]
  target?: {
    type: 'homework_submission' | 'creative_work_intake'
    id: string
  }
  target_projection?: ImageTaskTargetProjectionDTO
  progress: ImageTaskProgressDTO
  version: number
  created_at: number
  updated_at: number
}

export interface ImageTaskDispatchResp {
  dispatch: ImageTaskDispatchDTO
}

export interface CreateImageTaskReq {
  agent: string
  source_session: string
  source_kind: 'desktop' | 'api' | 'im_direct'
  source_ref: string
  source_asset_refs: string[]
  message_intent?: string
  attempt_generation: number
  route_request: {
    provider?: string
    model?: string
    selection_source?: 'explicit' | 'auto'
  }
  creative_entry?: {
    kind: 'new_work'
    task_intent: 'writing' | 'artwork'
  }
}

/** 逐题确认/修正（空字段 = 该维度按识别结果确认不改）。 */
export interface GradingQuestionCorrection {
  index: number
  problem_id?: string
  /** 风险题必须逐题显式为 true；不能由整卷默认确认代替。 */
  confirmed?: boolean
  question?: string
  canonical_markdown?: string
  student_answer?: string
  answer_canonical_markdown?: string
  answer_state?: AnswerState
  subject?: string
}

export interface ConfirmImageTaskReq {
  agent: string
  version: number
  intent?: ImageTaskIntent
  homework?: {
    subject?: string
    grade?: string
    question_corrections: GradingQuestionCorrection[]
  }
  creative?:
    | {
        action: 'freeze_ocr'
        canonical_version: number
        canonical_content: string
        segment_corrections?: Array<{
          segment_id: string
          canonical_text: string
        }>
      }
    | {
        action: 'commit'
        work_title?: string
        content_markdown?: string
      }
}

export interface ImageTaskVersionReq {
  agent: string
  version: number
}

export interface ImageTaskCreateResp extends ImageTaskDispatchResp {
  created: boolean
}

export interface ImageTaskWorkFeedbackObservationDTO {
  dimension: string
  evidence: string
}

export interface ImageTaskWorkFeedbackSourceDTO {
  source: 'ai' | 'parent'
  method_ref: string
  capability: string
}

/** Closed, score-free feedback fact persisted with the formal work version. */
export interface ImageTaskStructuredFeedbackDTO {
  feedback_id: string
  version_id: string
  feedback_type: 'writing' | 'art'
  evidence_refs: string[]
  observations: ImageTaskWorkFeedbackObservationDTO[]
  source_snapshot: ImageTaskWorkFeedbackSourceDTO
  limitations: string
  suggestions: string[]
  projection_markdown: string
}

export interface ImageTaskCreativeFeedbackDTO {
  /** Same durable latest generation exposed by the CreativeWork detail/list DTO. */
  generation_id: string
  structured_feedback: ImageTaskStructuredFeedbackDTO
  /** Stable renderer field; must equal structured_feedback.projection_markdown. */
  projection_markdown: string
}

export interface ImageTaskCreativeResultPayload {
  intake: {
    intake_id: string
    status: CreativeWorkIntakeStatus
  }
  work?: {
    work_id: string
    display_name: string
  }
  /** Omitted until the formal CreativeWork is durably feedback_ready. */
  feedback?: ImageTaskCreativeFeedbackDTO
}

export type ImageTaskResultProjection =
  | { kind: 'completed_homework'; payload: PhotoJobResult }
  | { kind: 'blank_worksheet'; payload: PhotoJobResult }
  | { kind: 'writing'; payload: ImageTaskCreativeResultPayload }
  | { kind: 'artwork'; payload: ImageTaskCreativeResultPayload }

export interface ImageTaskSourceAttachmentReceipt {
  digest: string
  size_bytes: number
}

export interface ImageTaskRequestPolicyReceipt {
  policy_version: string
  stage: string
  thinking: string
  reasoning_effort: string
}

export interface ImageTaskOperationReceipt {
  invocation_id: string
  operation: string
  provider: string
  model: string
  status: string
  attempt: number
  /** Empty only when the durable terminal operation has no provider result. */
  result_digest: string
  parent_invocation_id?: string
  physical_unit?: string
  request_policy_digest?: string
  request_policy?: ImageTaskRequestPolicyReceipt
}

interface ImageTaskResultRespBase {
  dispatch_id: string
  task_intent: ImageTaskIntent
  status: ImageTaskDispatchStatus
  result: ImageTaskResultProjection | null
}

/**
 * Current Sidecars expose the audit envelope. A legacy installed Sidecar may
 * expose no audit fields at all; partial audit envelopes are rejected at the
 * wire boundary below.
 */
export type ImageTaskResultResp =
  | ImageTaskResultRespBase
  | (ImageTaskResultRespBase & {
      source_digest: string
      source_attachments: ImageTaskSourceAttachmentReceipt[]
      operation_receipts: ImageTaskOperationReceipt[]
    })

export async function k12CreateImageTask(req: CreateImageTaskReq, signal?: AbortSignal) {
  const response = await apiPost<unknown>(`${BASE}/image-tasks`, req, {
    timeout: 60_000,
    signal,
  })
  try {
    assertK12ImageTaskCreateResponse(response)
    normalizeImageTaskDispatchEnvelope(response)
    return response as unknown as ImageTaskCreateResp
  } catch (cause) {
    throw Object.assign(new Error('Invalid image task create response'), { cause })
  }
}
/** 查询分流、公开子链停点与最小冲突；内部 invocation/provider 不在该 DTO 中。 */
export async function k12GetImageTask(agent: string, dispatchId: string, signal?: AbortSignal) {
  const response = await apiGet<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}`,
    { agent },
    { signal },
  )
  try {
    assertK12ImageTaskDispatchResponse(response)
    normalizeImageTaskDispatchEnvelope(response)
    return response as unknown as ImageTaskDispatchResp
  } catch (cause) {
    throw Object.assign(new Error('Invalid image task dispatch response'), { cause })
  }
}
/** 读取同一 dispatch 的四类判别式终态结果，不从状态文案推断领域类型。 */
export async function k12GetImageTaskResult(
  agent: string,
  dispatchId: string,
  signal?: AbortSignal,
) {
  const response = await apiGet<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}/result`,
    { agent },
    { signal },
  )
  try {
    assertK12ImageTaskResultResponse(response)
    assertImageTaskResultSemantics(response)
    return response as unknown as ImageTaskResultResp
  } catch (cause) {
    throw Object.assign(new Error('Invalid image task result response'), { cause })
  }
}
/** 只提交当前 dispatch 版本声明的意图或目标子链最小冲突。 */
export async function k12ConfirmImageTask(
  dispatchId: string,
  req: ConfirmImageTaskReq,
  signal?: AbortSignal,
) {
  const response = await apiPost<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}/confirm`,
    req,
    { timeout: 60_000, signal },
  )
  try {
    assertK12ImageTaskDispatchResponse(response)
    normalizeImageTaskDispatchEnvelope(response)
    return response as unknown as ImageTaskDispatchResp
  } catch (cause) {
    throw Object.assign(new Error('Invalid image task dispatch response'), { cause })
  }
}
/** 安全重试只沿服务端冻结的 operation snapshot/checkpoint 恢复。 */
export async function k12RetryImageTask(
  dispatchId: string,
  req: ImageTaskVersionReq,
  signal?: AbortSignal,
) {
  const response = await apiPost<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}/retry`,
    req,
    { timeout: 60_000, signal },
  )
  try {
    assertK12ImageTaskDispatchResponse(response)
    normalizeImageTaskDispatchEnvelope(response)
    return response as unknown as ImageTaskDispatchResp
  } catch (cause) {
    throw Object.assign(new Error('Invalid image task dispatch response'), { cause })
  }
}
/** 显式取消 facade；TaskShell close、切会话或 AbortSignal 都不能隐式调用。 */
export async function k12CancelImageTask(
  dispatchId: string,
  req: ImageTaskVersionReq,
  signal?: AbortSignal,
) {
  const response = await apiPost<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}/cancel`,
    req,
    { timeout: 60_000, signal },
  )
  try {
    assertK12ImageTaskDispatchResponse(response)
    normalizeImageTaskDispatchEnvelope(response)
    return response as unknown as ImageTaskDispatchResp
  } catch (cause) {
    throw Object.assign(new Error('Invalid image task dispatch response'), { cause })
  }
}

/** 提交题目级来源命令；身份只由服务端 scope/持久 dispatch 解析。 */
export async function k12SubmitImageTaskProblemSourceAction(
  dispatchId: string,
  problemId: string,
  req: ImageTaskProblemSourceActionReq,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  const key = idempotencyKey.trim()
  if (!key) throw new Error('Idempotency-Key is required')
  const response = await apiPost<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}/problems/${encodeURIComponent(problemId)}/source-actions`,
    req,
    {
      timeout: 60_000,
      signal,
      headers: { 'Idempotency-Key': key },
    },
  )
  assertK12ImageTaskProblemSourceActionResponse(response)
  assertImageTaskProblemSourceActionSemantics(response, {
    dispatchId,
    problemId,
    action: req.action,
    structureVersion: req.structure_version,
    expectedInputRevision: req.expected_input_revision,
  })
  return response
}

// ── tutor-turn（渐进提示三阶段 + 情绪守门）────────────────────
export interface TutorTurnReq {
  agent: string
  /** 上一轮阶段（首轮传 0，之后回传上一轮响应的 stage） */
  prior_stage: number
  /** 家长本轮消息（后端据此检测"不会/直接讲"升级 + "哭了/生气"情绪守门） */
  parent_message?: string
  /** 家长转述的孩子作答（非空 → 至少进阶段二批改） */
  student_answer?: string
  /** 题目（阶段三取验算解用） */
  problem?: string
  grade?: string
}
export interface TutorTurnResp {
  /** 1 方向提示 / 2 具体提示·批改 / 3 完整讲解 */
  stage: 1 | 2 | 3
  /** 情绪守门命中：本轮切安抚、不推进、不给解 */
  comfort: boolean
  emotion_cue?: string
  escalated: boolean
  /** 给上游会话 LLM 的分阶段行为指令（前端连同题目发给模型生成家长话术） */
  prompt_hint: string
  /** 仅阶段三：经 solve 验算链的完整解 */
  solution?: string
  /** 阶段三验算徽章（同 GradeBadge 语义） */
  badge?: string
}
export function k12TutorTurn(req: TutorTurnReq) {
  return apiPost<TutorTurnResp>(`${BASE}/tutor-turn`, req, { timeout: 120_000 })
}

// ── bind-im（IM 群绑定：各绑各的群，写 agent_rules）───────────
export interface BindIMReq {
  agent: string
  /** IM 平台：dingtalk / feishu / … */
  platform: string
  instance_id?: string
  /** 家庭群/会话 ID */
  chat_id: string
}
/** 未注入 router（非桌面）→ 501；成功 → {bound:true,...} */
export function k12BindIM(req: BindIMReq) {
  return apiPost<{ bound: boolean; agent: string; platform: string; chat_id: string }>(
    `${BASE}/bind-im`,
    req,
  )
}

// ── cron 默认任务 reconciliation（missing-only 补齐 4 项）─────
export interface ProvisionCronReq {
  agent: string
  /** 投递到的 IM 平台；空 → 桌面 chat */
  platform?: string
  chat_id?: string
  /** 投递目标；空 → 平台默认 chat */
  deliver?: string[]
  /** 本机 API 基址；服务器已配 Runtime.BaseURL 时可省 */
  base_url?: string
}
export interface ProvisionedJob {
  kind: string
  name: string
  schedule: string
  job_id: string
}
/** provision 时被回收的历史 K12 任务（§6.14 stale kind 回收取证）。 */
export interface ReclaimedCronJob {
  job_id: string
  name: string
  source_key: string
}
/**
 * 建档/改档成功后按具体 agent 调用；未注入 cron.Scheduler → 501。
 * 后端仅补 §3.13 四任务缺项，已有 exact SourceKey 任务保持原样。
 */
export async function k12ProvisionCron(req: ProvisionCronReq) {
  const response = await apiPost<{ provisioned: ProvisionedJob[]; reclaimed?: ReclaimedCronJob[] }>(
    `${BASE}/cron/reconcile-defaults`,
    { ...req, user_id: DESKTOP_USER_ID },
  )
  const expected = new Set(['weekly-sheet', 'return-reminder', 'semester-spring', 'semester-fall'])
  const actual = response.provisioned ?? []
  const actualKinds = new Set(actual.map((job) => job.kind))
  if (
    actual.length !== expected.size ||
    actualKinds.size !== expected.size ||
    [...expected].some((kind) => !actualKinds.has(kind))
  ) {
    throw new Error('K12 默认自动化任务契约不完整：必须恰好返回 4 个冻结任务')
  }
  return response
}

// ── 练习集 PracticeSet（/practice-sets*，PRD §3.8）─────────────
// DTO 与后端 scenarios/k12/apihttp/practiceset_handler.go 的 json tag 1:1 对齐。
export type PracticeStatus =
  | 'draft'
  | 'confirmed'
  | 'assigned'
  | 'submitted'
  | 'graded'
  | 'closed'
  | 'cancelled'
export type PracticeItemStatus = 'pending' | 'verified' | 'needs_review' | 'rejected' | 'stale'
export type PracticeResultEvidence = 'system_verified' | 'human_confirmed'
export type PracticeRegradeStatus =
  | 'queued'
  | 'running'
  | 'needs_review'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'outcome_unknown'
export interface PracticeRegradeRouteSnapshot {
  provider: string
  model: string
  route: string
  capability?: string
  timeout_ms?: number
  fallback?: string
}
/** 装篮来源（PRD §5.5 added_via）：装篮五入口的 item 级记录 */
export type PracticeAddedVia = 'weekly' | 'custom' | 'single_variant' | 'manual' | 'accumulation'
export interface PracticeItemDTO {
  item_id: string
  source_problem_id?: string
  subject?: string
  added_via?: PracticeAddedVia
  question_markdown: string
  expected_answer_markdown?: string
  verification_status: PracticeItemStatus
  verification_evidence?: string
  blocked_reason?: string
  /** 固化后的卷面题号；阻断题为空。 */
  paper_seq?: number
  /** 该题作答是否已回传。 */
  returned?: boolean
  /** 覆盖该题的追加回传批次，可据此反查原照片证据（DD-028）。 */
  return_ids?: string[]
  /** 正式自定义组卷命令及参数回执（DD-027），普通装篮项为空。 */
  generation_job_id?: string
  variant_index?: number
  requested_difficulty?: CustomPaperDifficulty
  actual_difficulty?: CustomPaperDifficulty
  /** 逐题复批结论；缺省表示尚未记录。 */
  result_correct?: boolean
  /** 系统独立核验 / 家长手工兜底；二者不得混同为同等级掌握证据。 */
  result_evidence?: PracticeResultEvidence
}
export interface PracticeReturnAssetDTO {
  return_id: string
  asset_id: string
  item_ids: string[]
  /** 服务端 Unix 秒。 */
  returned_at: number
  /** 自动复批的耐久任务及其冻结模型路由。 */
  regrade_job_id?: string
  regrade_status?: PracticeRegradeStatus
  route_snapshot?: PracticeRegradeRouteSnapshot
  /** 自动批注后的原图与家长讲题说明。 */
  annotated_asset_id?: string
  result_markdown?: string
  /** 只有这些真实不确定项进入最小人工核对。 */
  unresolved_item_ids?: string[]
  /** 服务端 Unix 秒。 */
  regrade_updated_at?: number
}
export interface PracticeSetDTO {
  record_id: string
  title: string
  source_kind: string
  status: PracticeStatus
  /** 后端固定 UI 译名：草稿/已确认/待完成/已回传/已批改/已关闭/已取消 */
  status_label: string
  /** 全部题目 verified 且非空 → true；固化出卷（发布门）依据 */
  publishable: boolean
  question_artifact_id?: string
  answer_artifact_id?: string
  /** 固化时被跳过的阻断题数（§3.8，购物车裁决）——逐题跳过非 verified 项，不拒整卷 */
  skipped_blocked_count?: number
  /** 卷面号（§4.13 双 ID）：固化时分配 P-{YY}{ISO周}-{序}，印页眉/回传关联；draft 无 */
  paper_no?: string
  /** 固化时间（unix 秒）：历史倒序排序依据；draft 无 */
  finalized_at?: number
  /** 固化方式 print | send */
  finalized_via?: string
  /** via=send 时冻结的全绑定投递批次；重放与重启恢复只能查询这个批次。 */
  delivery_batch_id?: string
  delivery_status: string
  items: PracticeItemDTO[]
  /** 只追加、不覆盖的作答照片批次（DD-028）。 */
  return_assets: PracticeReturnAssetDTO[]
}
// k12CreatePracticeSet（整卷直建 POST /practice-sets）已随切换日死刑名单删除
// （执行计划 §3.4 端点冻结 · 2026-07-18）：装篮命令（k12AddToBasket → k12FinalizePracticeSet）
// 是唯一创建路径，前端从未对接整卷直建。
export function k12ListPracticeSets(agent: string, status?: string) {
  return apiGet<{ items: PracticeSetDTO[] }>(
    `${BASE}/practice-sets`,
    status ? { agent, status } : { agent },
  )
}
export function k12GetPracticeSet(agent: string, recordId: string) {
  return apiGet<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}`, { agent })
}
/** 标某题验证态；status='verified' 必带 evidence，否则后端 4xx */
export function k12VerifyPracticeItem(
  agent: string,
  recordId: string,
  itemId: string,
  status: PracticeItemStatus,
  evidence?: string,
) {
  return apiPost<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}/verify`, {
    agent,
    item_id: itemId,
    status,
    evidence: evidence ?? '',
  })
}
// ── 购物车模型（2026-07-18 裁决）：单 Learner 单篮，打印/发送即确认固化 ──
export interface AddToBasketReq {
  agent: string
  source_session?: string
  item: PracticeItemDTO
}
/** 装篮（幂等去重：同题重复装篮 added=false）。篮不存在则自动建（draft 待打印篮）。 */
export function k12AddToBasket(req: AddToBasketReq) {
  return apiPost<{ record_id: string; added: boolean }>(`${BASE}/practice-sets/basket/items`, req)
}

export type CustomPaperScope = 'week' | 'unmastered'
export type CustomPaperTotal = 'all' | 5 | 10
export type CustomPaperDifficulty = 'same' | 'easier' | 'harder'
export type PracticeGenerationStatus =
  | 'queued'
  | 'generating'
  | 'validating'
  | 'committed'
  | 'failed'
  | 'cancelled'

export interface CustomPaperReq {
  agent: string
  idempotency_key: string
  scope: CustomPaperScope
  total: CustomPaperTotal
  per_source: 1 | 2 | 3
  difficulty: CustomPaperDifficulty
  textbook: string
  grade?: string
  source_session?: string
  provider?: string
  model?: string
}

export interface CustomPaperItemDTO {
  item_id: string
  source_problem_id: string
  variant_index: number
  actual_difficulty: CustomPaperDifficulty
  verification_status: PracticeItemStatus
  verification_evidence?: string
  blocked_reason?: string
  question_markdown: string
  expected_answer_markdown?: string
}

export interface CustomPaperResp {
  generation_job_id: string
  status: PracticeGenerationStatus
  set: PracticeSetDTO
  items: CustomPaperItemDTO[]
  added: number
  deduplicated: number
}

/** DD-027 正式组卷：Desktop 只发送一个冻结命令，不逐题 retry/add-to-basket 拼卷。 */
export function k12GenerateCustomPaper(req: CustomPaperReq) {
  if (!req.agent.trim() || !req.idempotency_key.trim()) {
    throw new Error('组卷实例与幂等键不能为空')
  }
  if (!['week', 'unmastered'].includes(req.scope)) throw new Error('组卷范围无效')
  if (![1, 2, 3].includes(req.per_source)) throw new Error('每道来源题只能生成 1/2/3 道变式')
  if (!['same', 'easier', 'harder'].includes(req.difficulty)) throw new Error('组卷难度无效')
  if (!['all', 5, 10].includes(req.total)) throw new Error('总题量只能是全部、5 或 10')
  if (!req.textbook.trim()) throw new Error('请先确认教材版本')
  const hasProvider = !!req.provider?.trim()
  const hasModel = !!req.model?.trim()
  if (hasProvider !== hasModel) throw new Error('组卷模型路由必须同时包含供应商和模型')
  return apiPost<CustomPaperResp>(`${BASE}/practice-sets/custom-paper`, req)
}
/** 篮内移除某题（只出篮，不影响错题状态与复习安排） */
export function k12RemoveFromBasket(agent: string, recordId: string, itemId: string) {
  return apiPost<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}/items/remove`, {
    agent,
    item_id: itemId,
  })
}
/** finalize 响应：固化后的练习集 + 本次被跳过的阻断题数 */
export interface FinalizeResp {
  set: PracticeSetDTO
  skipped_blocked_count: number
  /** via=send 时随 PracticeSet 原子创建的全绑定投递批次。 */
  delivery_batch?: DeliveryBatchDTO
}
/**
 * 固化出卷（打印/发送即家长确认，§3.8 购物车裁决）：draft 一步到 assigned。
 * 逐题跳过非 verified 项（响应 skipped_blocked_count 明示）；一道 verified 都没有 → 后端 4xx。
 * via='send' 由服务端枚举当前辅导智能体全部有效私聊；Desktop 不传平台、接收人或目标。
 */
export function k12FinalizePracticeSet(agent: string, recordId: string, via: 'print' | 'send') {
  return apiPost<FinalizeResp>(`${BASE}/practice-sets/${recordId}/finalize`, {
    agent,
    via,
  })
}

export type PracticePrintJobStatus =
  | 'preparing'
  | 'dialog_open'
  | 'submitted'
  | 'printed'
  | 'cancelled'
  | 'failed'
  | 'outcome_unknown'

export interface PracticePrintJobDTO {
  print_job_id: string
  practice_set_id: string
  idempotency_key: string
  status: PracticePrintJobStatus
  paper_no: string
  artifact_kind: 'question' | 'answer'
  artifact_id: string
  question_artifact_id: string
  answer_artifact_id: string
  source_digest: string
  attempt_count: number
  native_job_id?: string
  native_receipt_id?: string
  printer_snapshot?: Record<string, unknown>
  failure_kind?: string
  failure_detail?: string
  prepared_at: number
  printed_at?: number
  updated_at: number
  version: number
}

export interface PracticePrintJobResp {
  print_job: PracticePrintJobDTO
  replayed?: boolean
}

export interface PracticePrintJobPaperDTO {
  print_job_id: string
  kind: 'question' | 'answer'
  title: string
  paper_no: string
  source_digest: string
  artifact_id: string
  markdown: string
}

export interface PracticePrintEventReq {
  status: Exclude<PracticePrintJobStatus, 'preparing'>
  native_job_id?: string
  native_receipt_id?: string
  printer_snapshot?: Record<string, unknown>
  failure_kind?: string
  failure_detail?: string
}

export interface NativePrintCommitReq {
  native_job_id: string
  native_receipt_id: string
  printer_snapshot: Record<string, unknown>
}

export type GenericPrintSourceKind =
  | 'tutoring_tips'
  | 'practice_question'
  | 'practice_answer'
  | 'weekly_practice_snapshot'
  | 'grading_final_artifact'

export interface PrepareGenericPrintJobReq {
  agent: string
  idempotency_key: string
  source_kind: GenericPrintSourceKind
  source_ref: string
  title: string
  canonical_markdown: string
}

export interface GenericPrintJobDTO {
  print_job_id: string
  idempotency_key: string
  status: PracticePrintJobStatus
  artifact_kind: GenericPrintSourceKind
  artifact_id: string
  source_kind: GenericPrintSourceKind
  source_ref: string
  title: string
  source_digest: string
  attempt_count: number
  native_job_id?: string
  native_receipt_id?: string
  printer_snapshot?: Record<string, unknown>
  failure_kind?: string
  failure_detail?: string
  prepared_at: number
  printed_at?: number
  updated_at: number
  version: number
}

export interface GenericPrintJobResp {
  print_job: GenericPrintJobDTO
  replayed?: boolean
}

export interface GenericPrintArtifactDTO {
  print_job_id: string
  artifact_id: string
  source_kind: GenericPrintSourceKind
  source_ref: string
  title: string
  source_digest: string
  markdown: string
}

export interface PrepareGradingFinalArtifactOutputReq {
  agent: string
  final_artifact_id: string
  final_artifact_digest: string
  title: string
}

export interface PreparePrintableArtifactResp {
  artifact: PrintableArtifactDTO
  replayed?: boolean
}

export function k12PrepareGradingFinalArtifactOutput(req: PrepareGradingFinalArtifactOutputReq) {
  if (
    !req.agent.trim() ||
    !req.final_artifact_id.trim() ||
    !req.final_artifact_digest.trim() ||
    !req.title.trim()
  ) {
    throw new Error('批改最终产物身份与标题不能为空')
  }
  return apiPost<PreparePrintableArtifactResp>(`${BASE}/print-artifacts`, req)
}

export function k12PrepareGenericPrintJob(req: PrepareGenericPrintJobReq) {
  if (
    !req.agent.trim() ||
    !req.idempotency_key.trim() ||
    !req.source_ref.trim() ||
    !req.title.trim() ||
    !req.canonical_markdown.trim()
  ) {
    throw new Error('打印实例、幂等键与不可变 Artifact 内容不能为空')
  }
  return apiPost<GenericPrintJobResp>(`${BASE}/print-jobs`, req)
}

export interface PrepareArtifactPrintJobReq {
  agent: string
  idempotency_key: string
  artifact_id: string
}

export function k12PrepareArtifactPrintJob(req: PrepareArtifactPrintJobReq) {
  if (!req.agent.trim() || !req.idempotency_key.trim() || !req.artifact_id.trim()) {
    throw new Error('打印实例、幂等键与 Artifact 不能为空')
  }
  return apiPost<GenericPrintJobResp>(`${BASE}/print-jobs`, req)
}

export function k12GetPrintArtifactContent(agent: string, artifactId: string) {
  return api<Blob, 'blob'>(`${BASE}/print-artifacts/${encodeURIComponent(artifactId)}/content`, {
    method: 'GET',
    query: { agent },
    responseType: 'blob',
  })
}

export function k12GetGenericPrintArtifact(agent: string, printJobId: string) {
  return apiGet<GenericPrintArtifactDTO>(`${BASE}/print-jobs/${printJobId}/paper`, { agent })
}

export function k12GetGenericPrintJob(agent: string, printJobId: string) {
  return apiGet<GenericPrintJobResp>(`${BASE}/print-jobs/${printJobId}`, { agent })
}

function validateNativePrintCommit(receipt: NativePrintCommitReq) {
  if (
    !receipt.native_job_id.trim() ||
    !receipt.native_receipt_id.trim() ||
    !receipt.printer_snapshot ||
    Object.keys(receipt.printer_snapshot).length === 0
  ) {
    throw new Error('打印完成必须携带原生任务、回执与打印机快照')
  }
}

export function k12CommitGenericPrintReceipt(
  agent: string,
  printJobId: string,
  receipt: NativePrintCommitReq,
) {
  validateNativePrintCommit(receipt)
  return apiPost<GenericPrintJobResp>(`${BASE}/print-jobs/${printJobId}/commit`, {
    agent,
    ...receipt,
  })
}

export function k12RecordGenericPrintEvent(
  agent: string,
  printJobId: string,
  event: PracticePrintEventReq,
) {
  if (
    event.status === 'printed' &&
    (!event.native_job_id ||
      !event.native_receipt_id ||
      !event.printer_snapshot ||
      Object.keys(event.printer_snapshot).length === 0)
  ) {
    throw new Error('打印完成必须携带原生任务、回执与打印机快照')
  }
  return apiPost<GenericPrintJobResp>(`${BASE}/print-jobs/${printJobId}/events`, {
    agent,
    ...event,
  })
}

export function k12RetryGenericPrintJob(agent: string, printJobId: string) {
  return apiPost<GenericPrintJobResp>(`${BASE}/print-jobs/${printJobId}/retry`, { agent })
}

/** DD-023A phase 1: freeze the paper and reserve one durable PrintJob. */
export function k12PreparePracticePrintJob(
  agent: string,
  recordId: string,
  idempotencyKey: string,
  artifactKind: 'question' | 'answer' = 'question',
) {
  if (!agent.trim() || !recordId.trim() || !idempotencyKey.trim()) {
    throw new Error('打印实例、练习集与幂等键不能为空')
  }
  return apiPost<PracticePrintJobResp>(`${BASE}/practice-sets/${recordId}/print-jobs`, {
    agent,
    idempotency_key: idempotencyKey,
    artifact_kind: artifactKind,
  })
}

export function k12GetPracticePrintJob(agent: string, printJobId: string) {
  return apiGet<PracticePrintJobResp>(`${BASE}/print-jobs/${printJobId}`, { agent })
}

export function k12CommitPracticePrintReceipt(
  agent: string,
  printJobId: string,
  receipt: NativePrintCommitReq,
) {
  validateNativePrintCommit(receipt)
  return apiPost<PracticePrintJobResp>(`${BASE}/print-jobs/${printJobId}/commit`, {
    agent,
    ...receipt,
  })
}

export function k12GetPracticePrintJobPaper(
  agent: string,
  printJobId: string,
  kind: 'question' | 'answer' = 'question',
) {
  return apiGet<PracticePrintJobPaperDTO>(`${BASE}/print-jobs/${printJobId}/paper`, {
    agent,
    kind,
  })
}

/** DD-023A phase 2: persist the native dialog/driver receipt before UI success. */
export function k12RecordPracticePrintEvent(
  agent: string,
  printJobId: string,
  event: PracticePrintEventReq,
) {
  if (event.status === 'printed' && (!event.native_job_id || !event.native_receipt_id)) {
    throw new Error('打印完成必须携带原生任务与回执')
  }
  return apiPost<PracticePrintJobResp>(`${BASE}/print-jobs/${printJobId}/events`, {
    agent,
    ...event,
  })
}

export function k12RetryPracticePrintJob(agent: string, printJobId: string) {
  return apiPost<PracticePrintJobResp>(`${BASE}/print-jobs/${printJobId}/retry`, { agent })
}
/** submit/grade/close 顺序推进；非法转移 → 409 */
export function k12AdvancePracticeSet(
  agent: string,
  recordId: string,
  step: 'submit' | 'grade' | 'close',
) {
  return apiPost<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}/${step}`, { agent })
}

/**
 * 回传作答照片后标记照片覆盖到的题。前端禁止空 item_ids，避免旧端点的“空=整卷回传”
 * 兼容语义误把未上传/未覆盖的题全部标为已回传。asset_id 为已落本地资产服务的照片证据。
 */
export interface SubmitPracticeReturnReq {
  return_id: string
  asset_id: string
  item_ids: string[]
}

export function k12SubmitPracticeSet(
  agent: string,
  recordId: string,
  req: SubmitPracticeReturnReq,
) {
  if (!req.return_id.trim()) throw new Error('回传批次不能为空')
  if (!req.item_ids.length) throw new Error('至少选择一道照片覆盖的题目')
  if (!req.asset_id.trim()) throw new Error('请先上传作答照片')
  return apiPost<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}/submit`, {
    agent,
    return_id: req.return_id,
    asset_id: req.asset_id,
    item_ids: req.item_ids,
  })
}

export interface PracticeGradeResult {
  item_id: string
  correct: boolean
}

/** 逐题复批；禁止空 results 触发后端旧兼容的“整卷全通过”。 */
export function k12GradePracticeSet(
  agent: string,
  recordId: string,
  results: PracticeGradeResult[],
) {
  if (!results.length) throw new Error('请逐题记录对或错')
  return apiPost<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}/grade`, { agent, results })
}

/** 手动生成本周复习卷：复用后端 canonical_answer + 学科验证门的到期题装篮链。 */
export function k12FillPracticeBasket(agent: string) {
  return apiPost<{ added: number; skipped: number }>(
    `${BASE}/cron/fill-basket?agent=${encodeURIComponent(agent)}`,
    {},
  )
}
/** 仅 draft/confirmed 可取消，否则 409 */
export function k12CancelPracticeSet(agent: string, recordId: string) {
  return apiPost<PracticeSetDTO>(`${BASE}/practice-sets/${recordId}/cancel`, { agent })
}
/** 练习卷渲染结果（§4.13 呈现物真实渲染，GET /practice-sets/{id}/paper） */
export interface PracticePaperResp {
  kind: 'question' | 'answer'
  title: string
  /** 卷面号；draft 预览为空（固化才分配） */
  paper_no: string
  /** 卷面 Markdown（§4.13 版面：页眉卷面号+学期+日期、paper_seq 题号、分页页脚） */
  markdown: string
  /** true = draft 预览（与固化正卷同渲染器同口径，诚实预览） */
  preview: boolean
}
/**
 * 取题目卷/答案卷（§4.13）：kind 缺省 question。固化后为正卷（含卷面号）；
 * draft 篮走同一渲染器返回预览（preview=true）——预览口径 = 固化产物口径。
 */
export function k12GetPracticePaper(
  agent: string,
  recordId: string,
  kind: 'question' | 'answer' = 'question',
) {
  return apiGet<PracticePaperResp>(`${BASE}/practice-sets/${recordId}/paper`, { agent, kind })
}

// ── 作品 CreativeWork（/creative-works*，PRD §3.10）─────────────
export type WorkType = 'writing' | 'art'
export type WorkFeedbackGenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export interface WorkFeedbackSourceSnapshotDTO {
  /** `parent` is retained only to render historical feedback; new feedback is server-generated. */
  source: 'ai' | 'parent'
  method_ref: string
  capability: string
}
export interface WorkFeedbackDTO {
  feedback_id: string
  feedback_type: WorkType
  evidence_refs: string[]
  visible_evidence: string[]
  affirmation: string
  parent_guidance: string
  next_step: string
  source_snapshot: WorkFeedbackSourceSnapshotDTO
  limitations?: string
  projection_markdown?: string
}

export interface WorkFeedbackGenerationDTO {
  generation_id: string
  status: WorkFeedbackGenerationStatus
  feedback?: WorkFeedbackDTO
  failure_message?: string
}

export interface CreativeWorkDTO {
  work_id: string
  work_type: WorkType
  /** Neutral display label; it is not an inferred child-authored title. */
  display_name: string
  /** Present only when a parent entered an artwork's real, existing title. */
  work_title?: string
  content_markdown?: string
  source_asset_id?: string
  row_version: number
  initial_feedback: WorkFeedbackGenerationDTO
  latest_feedback?: WorkFeedbackGenerationDTO
  delivery_batch_id?: string
}

export interface CreateWorkReq {
  agent: string
  work_type: 'writing'
  content_markdown: string
  /** Command metadata; sent as Idempotency-Key, never as a business JSON field. */
  command_id: string
}

interface LegacyWorkFeedbackDTO {
  feedback_id?: string
  evidence_refs?: string[]
  observations?: Array<{ evidence?: string }>
  source_snapshot?: WorkFeedbackSourceSnapshotDTO
  limitations?: string
  suggestions?: string[]
  projection_markdown?: string
}

interface LegacyWorkVersionDTO {
  source_asset_id?: string
  content_markdown?: string
  feedback?: string
  structured_feedback?: LegacyWorkFeedbackDTO
  feedback_source?: 'ai' | 'parent' | string
  feedback_skill?: string
}

interface CreativeWorkWireDTO extends Partial<CreativeWorkDTO> {
  record_id?: string
  title?: string
  status?: string
  versions?: LegacyWorkVersionDTO[]
  initial_feedback_generation?: WorkFeedbackGenerationDTO
  latest_feedback_generation?: WorkFeedbackGenerationDTO
}

function legacyFeedback(
  workType: WorkType,
  workID: string,
  version: LegacyWorkVersionDTO,
): WorkFeedbackDTO | undefined {
  const structured = version.structured_feedback
  const projection = structured?.projection_markdown?.trim() || version.feedback?.trim() || ''
  if (!structured && !projection) return undefined
  const suggestions = structured?.suggestions?.filter(Boolean) ?? []
  return {
    feedback_id: structured?.feedback_id || `legacy-feedback:${workID}`,
    feedback_type: workType,
    evidence_refs: structured?.evidence_refs ?? [],
    visible_evidence:
      structured?.observations?.map((item) => item.evidence?.trim() || '').filter(Boolean) ?? [],
    affirmation: suggestions[0] ?? '',
    parent_guidance: suggestions[1] ?? '',
    next_step: suggestions[2] ?? '',
    limitations: structured?.limitations,
    projection_markdown: projection,
    source_snapshot: structured?.source_snapshot ?? {
      source: version.feedback_source === 'parent' ? 'parent' : 'ai',
      method_ref: version.feedback_skill || 'legacy-read-only',
      capability: 'creative-work-feedback',
    },
  }
}

function normalizeCreativeWork(raw: CreativeWorkWireDTO): CreativeWorkDTO {
  const workID = raw.work_id || raw.record_id || ''
  const workType: WorkType = raw.work_type === 'art' ? 'art' : 'writing'
  const legacyVersion = raw.versions?.[raw.versions.length - 1]
  const legacyLatest = legacyVersion ? legacyFeedback(workType, workID, legacyVersion) : undefined
  const initial =
    raw.initial_feedback ??
    raw.initial_feedback_generation ??
    ({
      generation_id: `legacy-initial:${workID}`,
      status: legacyLatest ? 'succeeded' : raw.status === 'feedback_failed' ? 'failed' : 'running',
      feedback: legacyLatest,
    } satisfies WorkFeedbackGenerationDTO)
  const latest =
    raw.latest_feedback ??
    raw.latest_feedback_generation ??
    (legacyLatest
      ? ({
          generation_id: initial.generation_id,
          status: 'succeeded',
          feedback: legacyLatest,
        } satisfies WorkFeedbackGenerationDTO)
      : undefined)
  const fallbackName = workType === 'writing' ? '语文写作' : '美术作品'
  const displayName = raw.display_name?.trim() || raw.title?.trim() || fallbackName
  return {
    work_id: workID,
    work_type: workType,
    display_name: displayName,
    work_title: raw.work_title?.trim() || (workType === 'art' ? raw.title?.trim() : undefined),
    content_markdown: raw.content_markdown ?? legacyVersion?.content_markdown,
    source_asset_id: raw.source_asset_id ?? legacyVersion?.source_asset_id,
    row_version: Number(raw.row_version ?? 0),
    initial_feedback: initial,
    latest_feedback: latest,
    delivery_batch_id: raw.delivery_batch_id,
  }
}

export async function k12ListCreativeWorks(agent: string, type?: WorkType) {
  const response = await apiGet<{ items: CreativeWorkWireDTO[] }>(
    `${BASE}/creative-works`,
    type ? { agent, type } : { agent },
  )
  return { items: response.items.map(normalizeCreativeWork) }
}
export async function k12GetCreativeWork(agent: string, workId: string) {
  const response = await apiGet<CreativeWorkWireDTO>(
    `${BASE}/creative-works/${encodeURIComponent(workId)}`,
    { agent },
  )
  return normalizeCreativeWork(response)
}
export function k12CreateCreativeWork(req: CreateWorkReq) {
  return apiPost<{
    work_id: string
    created: boolean
    initial_feedback_generation_id: string
  }>(
    `${BASE}/creative-works`,
    {
      agent: req.agent,
      work_type: req.work_type,
      content_markdown: req.content_markdown,
    },
    { headers: { 'Idempotency-Key': req.command_id } },
  )
}
/**
 * 首轮失败时由服务端恢复同一 generation；已有 latest 时按 commandId 追加一代。
 * commandId 属于命令元数据，只通过 Idempotency-Key 传输。
 */
export async function k12GenerateWorkFeedback(
  agent: string,
  workId: string,
  commandId: string,
  signal?: AbortSignal,
) {
  const response = await apiPost<CreativeWorkWireDTO>(
    `${BASE}/creative-works/${encodeURIComponent(workId)}/generate-feedback`,
    { agent },
    {
      timeout: 240_000,
      signal,
      headers: { 'Idempotency-Key': commandId },
    },
  )
  return normalizeCreativeWork(response)
}

/** 建立整份作品的全绑定 DeliveryBatch；不发送独立点评子对象。 */
export function k12SendCreativeWork(agent: string, workId: string) {
  return apiPost<DeliveryBatchDTO>(`${BASE}/creative-works/${encodeURIComponent(workId)}/send`, {
    agent,
  })
}

export interface DeleteCreativeWorkReceiptDTO {
  deleted: boolean
  work_id: string
  row_version: number
}

/** CAS + 幂等 tombstone；调用方仅在本请求成功后移除本地投影。 */
export function k12DeleteCreativeWork(
  agent: string,
  workId: string,
  rowVersion: number,
  commandId: string,
) {
  return api<DeleteCreativeWorkReceiptDTO>(`${BASE}/creative-works/${encodeURIComponent(workId)}`, {
    method: 'DELETE',
    query: { agent },
    headers: {
      'If-Match': String(rowVersion),
      'Idempotency-Key': commandId,
    },
  })
}
export type DeliveryReceiptStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'outcome_unknown'

export interface DeliveryReceiptDTO {
  delivery_id: string
  batch_id: string
  batch_ordinal: number
  agent_name: string
  object_kind: string
  object_id: string
  binding_id: string
  target: {
    platform: string
    instance_id?: string
    chat_id: string
    label?: string
  }
  status: DeliveryReceiptStatus
  dedupe_key: string
  payload_digest: string
  payload_json: string
  render_manifest_json: string
  external_message_id?: string
  attempt: number
  last_error?: string
  created_at: number
  updated_at: number
}

export type DeliveryBatchStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'partial_failed'
  | 'outcome_unknown'

export interface DeliveryBatchDTO {
  batch_id: string
  agent_name: string
  object_kind: string
  object_id: string
  dedupe_key: string
  content_digest: string
  status: DeliveryBatchStatus
  receipts: DeliveryReceiptDTO[]
  created_at: number
  updated_at: number
}

/** 将当前会话内已生成的辅导要点发送给该智能体绑定的全部有效私聊。 */
export function k12SendTutoringTips(agent: string, content: string) {
  return apiPost<DeliveryBatchDTO>(`${BASE}/tutoring-tips/send`, { agent, content })
}

/** 仅按冻结的批改最终产物身份发送；客户端不能注入或重新渲染正文。 */
export function k12SendGradingFinalArtifact(
  agent: string,
  finalArtifactId: string,
  finalArtifactDigest: string,
) {
  if (!agent.trim() || !finalArtifactId.trim() || !finalArtifactDigest.trim()) {
    throw new Error('批改最终产物身份不能为空')
  }
  return apiPost<DeliveryBatchDTO>(`${BASE}/tutoring-tips/send`, {
    agent,
    final_artifact_id: finalArtifactId,
    final_artifact_digest: finalArtifactDigest,
  })
}

/** 读取已经冻结目标快照的投递批次；不会重新枚举绑定，也不会触发发送。 */
export function k12GetDeliveryBatch(agent: string, batchId: string) {
  return apiGet<DeliveryBatchDTO>(`${BASE}/delivery-batches/${encodeURIComponent(batchId)}`, {
    agent,
  })
}

/** 仅重发 failed child；已送达目标不会再次发送。 */
export function k12RetryDeliveryBatch(agent: string, batchId: string) {
  return apiPost<DeliveryBatchDTO>(
    `${BASE}/delivery-batches/${encodeURIComponent(batchId)}/retry`,
    { agent },
  )
}

/** pending/sending/outcome_unknown 的唯一安全收敛动作；只查询原 child，不重发。 */
export function k12QueryDeliveryBatch(agent: string, batchId: string) {
  return apiPost<DeliveryBatchDTO>(
    `${BASE}/delivery-batches/${encodeURIComponent(batchId)}/query`,
    { agent },
  )
}

// ── 作品照片资产（/assets*，最小资产服务：魔数校验/10MB 上限/归属隔离）────
export interface AssetUploadResp {
  /** 自描述资产 ID：asset://<agent>/<sha256>.<ext>（内容寻址，同图幂等） */
  asset_id: string
  size: number
}

/** 资产回图 URL（<img :src>）：GET /assets/{file}?agent=——文件段取自 asset_id 尾段 */
export function k12AssetURL(agent: string, assetId: string): string {
  if (!assetId.startsWith('asset://')) return ''
  const file = assetId.slice(assetId.lastIndexOf('/') + 1)
  return `${env.apiBase}${BASE}/assets/${file}?agent=${encodeURIComponent(agent)}`
}

/** 上传作品照片（multipart + XHR：带真实上传进度回调）。魔数非图片 415、>10MB 413。 */
export function k12UploadAsset(
  agent: string,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<AssetUploadResp> {
  if (isTauri()) {
    return (async () => {
      const nativeFile = file as File & { nativeFileGrant?: NativeFileGrant }
      const grant =
        nativeFile.nativeFileGrant?.purpose === 'attachment_upload'
          ? nativeFile.nativeFileGrant
          : await stageBlob(file, file.name, {
              purpose: 'attachment_upload',
              operationId: createNativeFileOperation('k12-asset-upload'),
            })
      const idempotencyKey = `k12-asset:${globalThis.crypto.randomUUID()}`
      const receipt = await uploadGrantedFile<AssetUploadResp>({
        grant,
        url: `${env.apiBase}${BASE}/assets?agent=${encodeURIComponent(agent)}`,
        idempotencyKey,
        fieldName: 'file',
        signal,
        onProgress,
      })
      if (!receipt.body) throw new Error('Native upload returned no receipt body')
      return receipt.body
    })()
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => xhr.abort()
    xhr.open('POST', `${env.apiBase}${BASE}/assets?agent=${encodeURIComponent(agent)}`)
    xhr.timeout = 60_000
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      cleanup()
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>
      } catch {
        /* 非 JSON 响应按状态码兜底 */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as unknown as AssetUploadResp)
      } else {
        reject(
          new Error(
            typeof body.error === 'string' && body.error ? body.error : `上传失败（${xhr.status}）`,
          ),
        )
      }
    }
    xhr.onerror = () => {
      cleanup()
      reject(new Error('上传失败：网络错误'))
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new Error('上传超时，请重试'))
    }
    xhr.onabort = () => {
      cleanup()
      const error = new Error('上传已取消')
      error.name = 'AbortError'
      reject(error)
    }
    const form = new FormData()
    form.append('file', file, file.name)
    if (signal?.aborted) {
      const error = new Error('上传已取消')
      error.name = 'AbortError'
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    xhr.send(form)
  })
}

export interface RecoverableImageTask {
  source_session: string
  source_message_id: string
  dispatch: ImageTaskDispatchDTO
}

/** Sidecar-owned restart projection; renderer storage is never consulted. */
export async function k12ListRecoverableImageTasks(agent: string) {
  const response = await apiGet<{ items: RecoverableImageTask[] }>(
    '/api/k12/image-tasks/recoverable',
    { agent },
  )
  return response.items
}
