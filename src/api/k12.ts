/**
 * K12 家长备课助手后端契约（/api/k12/*）。
 * DTO 与后端 scenarios/k12/apihttp/handler.go 的 json tag 1:1 对齐（前端类型即契约）。
 *
 * 注意：K12 端点**不需要 user_id**，隔离键是 `agent`（= agents.name）。
 * 错误响应统一 {error: string}（语言不保证），由 client.ts normalizeApiError 提到 e.message。
 */
import { api, apiGet, apiPost, apiPut, apiDelete } from './client'
import { env } from '@/config/env'
import { DESKTOP_USER_ID } from '@/constants'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'

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
export type EvidenceType =
  | 'numeric_exec'
  | 'symbolic_exec'
  | 'heterogeneous_model'
  | 'heuristic'
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

// ── review/retry（再练一道，按错题出同知识点相似题·过 solve 验算链）──────────
export interface ReviewRetryReq {
  agent: string
  record_id: string
  grade: string
}
export interface ReviewRetryResp {
  /** 相似题 + 解答全文（复制/兼容用；守答案遮罩） */
  solution: string
  /** solve 验算裁决：agree/disagree/unverifiable/out_of_scope */
  verdict: string
  /** 验算徽章文案 */
  badge: string
  /** 题答分离（2026-07-18 P2 清偿）：题面（先显给孩子做）；后端拆不出时为空 → 整段遮罩回退 */
  question?: string
  /** 解答 + 答案部分（默认遮罩，家长点按才揭示） */
  answer?: string
  /** 最终答案（装篮 expected_answer_markdown 用） */
  expected_answer?: string
}

/** 「再练一道」：基于某错题出一道同知识点相似题，必过 solve 验算链（POST /review/retry）。
 *  signal：用户关弹窗时中止在途请求，不再空烧算力（BUG-20260712-#4）。 */
export function k12ReviewRetry(req: ReviewRetryReq, signal?: AbortSignal) {
  // 真机取证（BUG-20260712-#1）：retry = 生成变式题 + solve + code_exec 验算，实测 ~68s（正确性保证，
  // 别让它变快）。默认 30s timeout 会腰斩 abort → 前端弹层被静默关，家长看着点了没反应。给足 120s。
  return apiPost<ReviewRetryResp>(`${BASE}/review/retry`, req, { timeout: 120_000, signal })
}

// ── prep-card（备课卡，只读五段）─────────────────────────────
export interface PrepCardReq {
  agent: string
  grade: string
  knowledge_points?: string[]
}

/** source_label 是带 emoji 的中文串（📖 依据课本 / 🤖 AI 归纳·供参考（未校验）/ ⚠️ 本次未生成·请核对 / 🗂 本地记录 / ✅ 已程序验算 / 🧠 学情信号） */
export interface PrepSectionDTO {
  title: string
  content: string
  source_label: string
}

export interface PrepCardResp {
  knowledge_points: string[]
  sections: PrepSectionDTO[]
}

export function k12PrepCard(req: PrepCardReq, signal?: AbortSignal) {
  // LLM 生成辅导要点，默认 30s 会腰斩→「Fetch is aborted」（BUG-20260712-T1 真机取证）
  return apiPost<PrepCardResp>(`${BASE}/prep-card`, req, { timeout: 120_000, signal })
}

// ── grounding（家长教材原文，按 agent scope 写入）──────────
export interface GroundingReq {
  agent: string
  title: string
  content: string
}

export function k12AddGrounding(req: GroundingReq, signal?: AbortSignal) {
  return apiPost<{ ok: boolean }>(`${BASE}/grounding`, req, { signal })
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
  knowledge_point: string
  count: number
}
export interface InsightReportResp {
  trend: TrendCounts
  weak_top3: WeakPoint[]
  month_new_mistakes: number
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
/** 字段名对齐后端：grade_term / textbook_edition（非 grade/textbook） */
export interface ProfileDTO {
  child_name: string
  grade_term: string
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
export interface AccumDTO {
  record_id: string
  subject: string
  entry_type: string
  content: string
  source?: string
  status: string
  /** unix 秒；引文列表收藏日期（原型 20260718 定案 acc-date），旧后端无此字段时缺省 */
  created_at?: number
}
export interface AddAccumReq {
  agent: string
  source_session?: string
  subject: string
  entry_type: string
  content: string
  source?: string
}
// subject 可选：给了则触达后端 GET /accumulation?subject= 过滤（语/英分科），不给取全量（BUG-3）。
export function k12ListAccumulation(agent: string, subject?: string) {
  return apiGet<{ items: AccumDTO[] }>(
    `${BASE}/accumulation`,
    subject ? { agent, subject } : { agent },
  )
}
export function k12AddAccumulation(req: AddAccumReq) {
  return apiPost<{ record_id: string; created: boolean }>(`${BASE}/accumulation`, req)
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

// ── 识题产物类型（统一 GradingJob 停点回显消费，§6.7）──────
// 两阶段直连编排 k12Recognize / k12RecognizeAnchors 已随一次切换删除
// （§6.14 链路① · 2026-07-18）：识题→锚点→批改统一走下方 grading-jobs 段
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
  /** 仅锚点阶段之后出现（GradingJob 停点产物）；核心识题永远不携带坐标。 */
  bbox?: BBox | null
  recognition_confidence?: number
  confirmation_required?: boolean
  confirmation_reasons?: OCRConfirmationReason[]
  confirmed_version?: number
  input_digest?: string
}

// ── grading-jobs（统一 GradingJob：桌面拍照批改入口，§6.7/§6.15）──────────
// 桌面编排改道（执行计划 §3.4「入口自编排」收敛）：上传照片 → 创建 Job（后端异步推进）
// → 轮询到 awaiting_confirmation（响应携带识别停点产物）→ 确认/修正 → 轮询到 completed
// → 取逐题批改结果渲染。DTO 与 scenarios/k12/apihttp/gradingjob_handler.go 1:1 对齐。
export interface GradingCheckpointDTO {
  stage: string
  artifact_digest?: string
  recorded_at?: number
  degraded?: boolean
}
export interface GradingJobDTO {
  job_id: string
  submission_id: string
  stage: string
  confirmation_state: 'pending' | 'confirmed'
  anchor_state: 'pending' | 'located' | 'degraded'
  deadline: number
  idempotency_key: string
  confirmed_version: number
  stage_checkpoints?: GradingCheckpointDTO[]
  attempt_count: number
  failure_kind?: string
  retryable: boolean
  version: number
  created_at: number
  updated_at: number
  /** GET 详情在识别停点附带；创建/列表响应可缺省。 */
  recognized_questions?: RecognizedQuestion[]
}
/** 识别停点产物（awaiting_confirmation 起可用）：护栏回显数据源（含锚点 bbox）。 */
export interface GradingJobRecognition {
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
}
export interface PhotoJobResult {
  mode: string
  items: PhotoJobItemDTO[]
  markdown: string
  image_warning?: string
}
export interface GradingJobStatusResp {
  job_id: string
  stage: string
  confirmation_state: 'pending' | 'confirmed'
  anchor_state: 'pending' | 'located' | 'degraded'
  deadline: number
  confirmed_version: number
  job: GradingJobDTO
  recognition?: GradingJobRecognition
  result?: PhotoJobResult
}
export interface GradingJobResultResp {
  job_id: string
  result: PhotoJobResult
}
export interface CreatePhotoGradingJobReq {
  agent: string
  /** §4.10 统一幂等键：desktop 用请求标识；同键重投命中既有 Job（created=false）。 */
  source_key: string
  source_kind?: string
  image_base64: string
  subject?: string
  grade?: string
  source_session?: string
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
export interface ConfirmGradingJobReq {
  agent: string
  subject?: string
  grade?: string
  question_corrections?: GradingQuestionCorrection[]
}

/** 创建照片批改 Job：后端固化原图并**异步**推进（响应即回，不等识别完成）。 */
export function k12CreateGradingJob(req: CreatePhotoGradingJobReq, signal?: AbortSignal) {
  return apiPost<{ created: boolean; job: GradingJobDTO }>(`${BASE}/grading-jobs`, req, {
    timeout: 60_000,
    signal,
  })
}
/** 查询任务阶段 + 停点/终态产物（轮询端点；阶段耗时分钟级，调用方 2-3s 节流）。 */
export function k12GetGradingJob(agent: string, jobId: string, signal?: AbortSignal) {
  return apiGet<GradingJobStatusResp>(
    `${BASE}/grading-jobs/${encodeURIComponent(jobId)}`,
    { agent },
    { signal },
  )
}
/** 独立读取终态投影：Job 详情只承载阶段/停点，不隐式夹带批改结果。 */
export function k12GetGradingJobResult(agent: string, jobId: string, signal?: AbortSignal) {
  return apiGet<GradingJobResultResp>(
    `${BASE}/grading-jobs/${encodeURIComponent(jobId)}/result`,
    { agent },
    { signal },
  )
}
/** 批量确认/修正识别结果：冻结 canonical 输入后后端异步续跑到终态。 */
export function k12ConfirmGradingJob(jobId: string, req: ConfirmGradingJobReq) {
  return apiPost<GradingJobStatusResp>(
    `${BASE}/grading-jobs/${encodeURIComponent(jobId)}/confirm`,
    req,
    { timeout: 60_000 },
  )
}
/** 安全重试（failed_retryable 且 retryable）：回 queued 从检查点异步续跑。 */
export function k12RetryGradingJob(agent: string, jobId: string, signal?: AbortSignal) {
  return apiPost<GradingJobStatusResp>(
    `${BASE}/grading-jobs/${encodeURIComponent(jobId)}/retry`,
    { agent },
    { timeout: 60_000, signal },
  )
}
/** 取消仍在识别/等待确认的照片任务；换图或卸载时用于释放后端旧任务。 */
export function k12CancelGradingJob(agent: string, jobId: string) {
  return apiPost<GradingJobStatusResp>(
    `${BASE}/grading-jobs/${encodeURIComponent(jobId)}/cancel`,
    { agent },
    { timeout: 60_000 },
  )
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

// ── cron/provision（注册 4 个默认自动化任务）──────────────────
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
/** 建档后调一次；未注入 cron.Scheduler → 501。注册 §3.13 四任务并回收历史 kind 残留。 */
export async function k12ProvisionCron(req: ProvisionCronReq) {
  const response = await apiPost<{ provisioned: ProvisionedJob[]; reclaimed?: ReclaimedCronJob[] }>(
    `${BASE}/cron/provision`,
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
}
export interface PracticeReturnAssetDTO {
  return_id: string
  asset_id: string
  item_ids: string[]
  /** 服务端 Unix 秒。 */
  returned_at: number
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
  delivery_status: string
  delivery_target?: string
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
  /** send 尚未接真实投递器时的诚实状态说明。 */
  delivery_note?: string
}
/**
 * 固化出卷（打印/发送即家长确认，§3.8 购物车裁决）：draft 一步到 assigned。
 * 逐题跳过非 verified 项（响应 skipped_blocked_count 明示）；一道 verified 都没有 → 后端 4xx。
 * via='send' 必带 target（私聊目标）；via='print' 不投递。
 */
export function k12FinalizePracticeSet(
  agent: string,
  recordId: string,
  via: 'print' | 'send',
  target?: string,
) {
  return apiPost<FinalizeResp>(`${BASE}/practice-sets/${recordId}/finalize`, {
    agent,
    via,
    target: target ?? '',
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

export type GenericPrintSourceKind =
  | 'prep_card'
  | 'creative_observation_card'
  | 'practice_question'
  | 'practice_answer'

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

export function k12GetGenericPrintArtifact(agent: string, printJobId: string) {
  return apiGet<GenericPrintArtifactDTO>(`${BASE}/print-jobs/${printJobId}/paper`, { agent })
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
export type WorkStatus = 'draft' | 'feedback_ready' | 'revised' | 'archived'
export interface WorkFeedbackObservationDTO {
  dimension:
    | 'task_alignment'
    | 'structure'
    | 'expression'
    | 'language_detail'
    | 'composition'
    | 'color'
    | 'line'
    | 'visible_detail'
  evidence: string
}
export interface WorkFeedbackSourceSnapshotDTO {
  source: 'ai' | 'parent'
  method_ref: string
  capability: string
}
export interface WorkFeedbackDTO {
  feedback_id: string
  version_id: string
  feedback_type: WorkType
  evidence_refs: string[]
  observations: WorkFeedbackObservationDTO[]
  source_snapshot: WorkFeedbackSourceSnapshotDTO
  limitations: string
  suggestions: string[]
  allowed_actions: Array<'send' | 'print_practice_card' | 'collect' | 'record_language_issue'>
  projection_markdown: string
}
export interface WorkVersionDTO {
  version_id: string
  source_asset_id?: string
  content_markdown?: string
  /** DD-013 writing-photo confirmation evidence. */
  ocr_job_id?: string
  ocr_raw?: string
  ocr_version?: number
  ocr_confirmed_digest?: string
  content_confirmed_at?: number
  feedback?: string
  /** Canonical feedback fact; feedback Markdown is only a legacy projection. */
  structured_feedback?: WorkFeedbackDTO
  /** 点评实际来源：ai=后端 Skill 生成，parent=家长手写；老记录可为空。 */
  feedback_source?: 'ai' | 'parent' | string
  /** AI 点评实际使用的方法论版本戳；家长手写/老记录可为空。 */
  feedback_skill?: string
  /** 观察小练习卡文本（§3.10 美术）：服务端由点评正文提炼（单一事实源），写作/无点评缺省 */
  practice_card?: string
  /** 练习卡完成打卡时间（unix 秒；缺省 = 未打卡） */
  practice_card_done_at?: number
}
export interface CreativeWorkDTO {
  record_id: string
  work_type: WorkType
  title: string
  task: string
  intent?: string
  status: WorkStatus
  /** 后端译名：待点评/已点评/已修改/已归档 */
  status_label: string
  versions: WorkVersionDTO[]
}
export interface CreateWorkReq {
  agent: string
  source_session?: string
  work_type: WorkType
  title: string
  task: string
  intent?: string
  content_markdown?: string
  source_asset_id?: string
  ocr_job_id?: string
  ocr_version?: number
  ocr_confirmed_digest?: string
}
export function k12ListCreativeWorks(agent: string, type?: WorkType) {
  return apiGet<{ items: CreativeWorkDTO[] }>(
    `${BASE}/creative-works`,
    type ? { agent, type } : { agent },
  )
}
export function k12GetCreativeWork(agent: string, recordId: string) {
  return apiGet<CreativeWorkDTO>(`${BASE}/creative-works/${recordId}`, { agent })
}
export function k12CreateCreativeWork(req: CreateWorkReq) {
  return apiPost<{ record_id: string; created: boolean }>(`${BASE}/creative-works`, req)
}
/** 给最新版本附证据化点评（只点评不打分不代写，INV-011） */
export function k12AttachWorkFeedback(agent: string, recordId: string, feedback: string) {
  return apiPost<CreativeWorkDTO>(`${BASE}/creative-works/${recordId}/feedback`, {
    agent,
    feedback,
  })
}
/** 调后端 Skill 生成证据化点评；慢模型由调用方展示生成中/失败重试，不做前端假成功。 */
export function k12GenerateWorkFeedback(agent: string, recordId: string, signal?: AbortSignal) {
  return apiPost<CreativeWorkDTO>(
    `${BASE}/creative-works/${recordId}/generate-feedback`,
    { agent },
    { timeout: 240_000, signal },
  )
}
/** 提交修改稿形成新版本（feedback_ready → revised） */
export function k12SubmitWorkRevision(
  agent: string,
  recordId: string,
  contentMarkdown?: string,
  sourceAssetId?: string,
  ocr?: { jobId: string; version: number; digest: string },
) {
  return apiPost<CreativeWorkDTO>(`${BASE}/creative-works/${recordId}/revision`, {
    agent,
    content_markdown: contentMarkdown ?? '',
    source_asset_id: sourceAssetId ?? '',
    ...(ocr
      ? {
          ocr_job_id: ocr.jobId,
          ocr_version: ocr.version,
          ocr_confirmed_digest: ocr.digest,
        }
      : {}),
  })
}
export function k12ArchiveCreativeWork(agent: string, recordId: string) {
  return apiPost<{ ok: boolean }>(`${BASE}/creative-works/${recordId}/archive`, { agent })
}
export type DeliveryReceiptStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'outcome_unknown'

export interface DeliveryReceiptDTO {
  delivery_id: string
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

/** 点评/观察练习卡发送到手机。返回 durable Receipt；sending 仅表示平台受理，
 *  只有 query 返回 delivered 才能显示「已送达」。 */
export function k12SendWorkFeedback(
  agent: string,
  recordId: string,
  kind: 'feedback' | 'practice_card' = 'feedback',
) {
  return apiPost<DeliveryReceiptDTO>(`${BASE}/creative-works/${recordId}/send-feedback`, {
    agent,
    kind,
  })
}

/** 把当前会话内已经生成的备课卡文本按同一 Receipt 协议直发私聊。 */
export function k12SendPrepCard(agent: string, content: string) {
  return apiPost<DeliveryReceiptDTO>(`${BASE}/prep-card/send`, { agent, content })
}

export function k12GetDeliveryReceipt(agent: string, deliveryId: string) {
  return apiGet<DeliveryReceiptDTO>(`${BASE}/delivery-receipts/${deliveryId}`, { agent })
}

/** 只有 failed 可调用；sending/outcome_unknown 调用会被后端 409 拒绝。 */
export function k12RetryDeliveryReceipt(agent: string, deliveryId: string) {
  return apiPost<DeliveryReceiptDTO>(`${BASE}/delivery-receipts/${deliveryId}/retry`, { agent })
}

/** sending/outcome_unknown 的唯一安全收敛动作，不会再次发送消息。 */
export function k12QueryDeliveryReceipt(agent: string, deliveryId: string) {
  return apiPost<DeliveryReceiptDTO>(`${BASE}/delivery-receipts/${deliveryId}/query`, { agent })
}
/** 观察练习卡完成打卡（幂等：保留首次时间；仅美术且已点评） */
export function k12MarkPracticeCardDone(agent: string, recordId: string) {
  return apiPost<CreativeWorkDTO>(`${BASE}/creative-works/${recordId}/practice-card/done`, {
    agent,
  })
}

// ── 作文照片 OCR Job（DD-013）────────────────────────────────
export type CreativeWorkOCRStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_confirmation'
  | 'failed'
  | 'confirmed'

export interface CreativeWorkOCRJobDTO {
  job_id: string
  request_id: string
  source_asset_id: string
  source_digest: string
  status: CreativeWorkOCRStatus
  ocr_raw?: string
  error_message?: string
  attempt_count: number
  confirmed_version?: number
  confirmed_digest?: string
  confirmed_content?: string
  confirmed_at?: number
  created_at: number
  updated_at: number
}

export function k12CreateCreativeWorkOCR(req: {
  agent: string
  request_id: string
  source_asset_id: string
}) {
  return apiPost<CreativeWorkOCRJobDTO>(`${BASE}/creative-work-ocr-jobs`, req, { timeout: 240_000 })
}

export function k12GetCreativeWorkOCR(agent: string, jobId: string) {
  return apiGet<CreativeWorkOCRJobDTO>(
    `${BASE}/creative-work-ocr-jobs/${encodeURIComponent(jobId)}`,
    { agent },
  )
}

export function k12RetryCreativeWorkOCR(agent: string, jobId: string) {
  return apiPost<CreativeWorkOCRJobDTO>(
    `${BASE}/creative-work-ocr-jobs/${encodeURIComponent(jobId)}/retry`,
    { agent },
    { timeout: 240_000 },
  )
}

export function k12ConfirmCreativeWorkOCR(agent: string, jobId: string, contentMarkdown: string) {
  return apiPost<CreativeWorkOCRJobDTO>(
    `${BASE}/creative-work-ocr-jobs/${encodeURIComponent(jobId)}/confirm`,
    { agent, content_markdown: contentMarkdown },
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
