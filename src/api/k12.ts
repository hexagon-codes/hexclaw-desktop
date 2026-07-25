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

// ── controlled mistake archive / restore（BUG-20260725-017）────────
export interface MistakeArchiveCommandReq {
  agent: string
  version: number
  idempotency_key: string
}

/** 「不再复习」：CAS 软归档。成功响应中的 version 是 Undo 唯一合法的 restore version。 */
export function k12ArchiveMistake(
  agent: string,
  recordId: string,
  version: number,
  idempotencyKey: string,
) {
  return apiPost<MistakeDTO>(`${BASE}/mistakes/${encodeURIComponent(recordId)}/archive`, {
    agent,
    version,
    idempotency_key: idempotencyKey,
  })
}

/** 8 秒 Undo 与「已归档」长期恢复共用的唯一 CAS restore。 */
export function k12RestoreMistake(
  agent: string,
  recordId: string,
  version: number,
  idempotencyKey: string,
) {
  return apiPost<MistakeDTO>(`${BASE}/mistakes/${encodeURIComponent(recordId)}/restore`, {
    agent,
    version,
    idempotency_key: idempotencyKey,
  })
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

// ── grounding（家长教材原文，按 agent scope 写入）──────────
export interface GroundingReq {
  agent: string
  /** 当前作业学科；不传仅保留旧版不分科语义。 */
  subject?: string
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
/** 将这条积累内容发送给当前辅导智能体绑定的全部有效私聊。
 *  接收人枚举、物理目标去重和目标快照全部由服务端完成。 */
export function k12SendAccumulation(agent: string, recordId: string) {
  return apiPost<DeliveryBatchDTO>(`${BASE}/accumulation/${encodeURIComponent(recordId)}/send`, {
    agent,
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
    digest: string
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
  entry_kind?: 'auto' | 'new_work' | 'revision'
  promotion_policy?: 'automatic' | 'explicit_commit'
  routing_provenance?: 'model_classified' | 'parent_selected'
  commit_required?: boolean
  commit_state?: 'pending' | 'committed'
  promoted_work_id?: string
  promoted_version_id?: string
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
  creative_entry?:
    | {
        kind: 'new_work'
        task_intent: 'writing' | 'artwork'
      }
    | {
        kind: 'revision'
        task_intent: 'writing' | 'artwork'
        work_id: string
        base_version_id: string
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
        task_requirement?: string
        intent?: string
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

export interface ImageTaskResultResp {
  dispatch_id: string
  task_intent: ImageTaskIntent
  status: ImageTaskDispatchStatus
  result: ImageTaskResultProjection | null
}

type ImageTaskWireRecord = Record<string, unknown>

const IMAGE_TASK_INTENTS = new Set<ImageTaskIntent>([
  'completed_homework',
  'blank_worksheet',
  'writing',
  'artwork',
  'unknown',
])
const IMAGE_TASK_STATUSES = new Set<ImageTaskDispatchStatus>([
  'routing',
  'awaiting_confirmation',
  'routed',
  'failed',
  'cancelled',
])
const IMAGE_TASK_HOMEWORK_STAGES = new Set<ImageTaskHomeworkStage>([
  'queued',
  'normalizing',
  'recognizing',
  'locating',
  'awaiting_confirmation',
  'assessing',
  'rendering',
  'projecting',
  'completed',
  'cancelled',
  'recovering',
  'failed_retryable',
  'failed_terminal',
])
const IMAGE_TASK_CREATIVE_STATUSES = new Set<CreativeWorkIntakeStatus>([
  'preparing',
  'awaiting_confirmation',
  'ready',
  'promoted',
  'failed',
  'cancelled',
])
const IMAGE_TASK_PROGRESS_OPERATIONS = new Set<ImageTaskProgressDTO['operation']>([
  'classification',
  'homework',
  'writing_ocr',
  'promotion',
])
const IMAGE_TASK_CREATIVE_FEEDBACK_STATES = new Set<ImageTaskCreativeFeedbackState>([
  'feedback_pending',
  'feedback_ready',
  'feedback_failed',
  'recovering',
])
const IMAGE_TASK_PROBLEM_KINDS = new Set<ProblemKind>([
  'standalone',
  'compound_parent',
  'subproblem',
])
const IMAGE_TASK_ANSWER_STATES = new Set<AnswerState>(['blank', 'present', 'unclear'])
const IMAGE_TASK_CONFIRMATION_REASONS = new Set<OCRConfirmationReason>([
  'fraction',
  'decimal_point',
  'negative_sign',
  'unit',
  'erasure',
  'evidence_conflict',
  'low_confidence',
  'unclear_handwriting',
  'subject_undetermined',
  'canonical_parse_failed',
])
const IMAGE_TASK_PHOTO_STATUSES = new Set<PhotoJobItemDTO['status']>([
  'correct',
  'wrong',
  'unanswered',
  'answer_unclear',
  'blank_solved',
  'out_of_scope',
  'untrusted',
  'failed',
])
const IMAGE_TASK_PHOTO_RESULT_KINDS = new Set<PhotoJobResultKind>([
  'assessment',
  'parent_teaching_guide',
  'unanswered',
  'needs_review',
  'out_of_scope',
  'failed',
])
const IMAGE_TASK_GRADE_VERDICTS = new Set<GradeVerdict>([
  'agree',
  'disagree',
  'unverifiable',
  'out_of_scope',
  'verbatim',
])
const IMAGE_TASK_GRADE_BADGES = new Set<GradeBadge>([
  'verified-strong',
  'verified-weak',
  'disagree',
  'out-of-scope',
  'unverifiable',
  'verbatim-recall',
])
const IMAGE_TASK_EVIDENCE_TYPES = new Set<EvidenceType>([
  'numeric_exec',
  'symbolic_exec',
  'heterogeneous_model',
  'heuristic',
  'verbatim',
  'none',
])

function imageTaskWireRecord(value: unknown, message: string): ImageTaskWireRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as ImageTaskWireRecord
}

function assertImageTaskKeys(
  value: ImageTaskWireRecord,
  required: readonly string[],
  optional: readonly string[],
  message: string,
) {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(message)
  }
}

function isImageTaskStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isImageTaskNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && !!item.trim())
  )
}

function assertImageTaskBBox(value: unknown, message: string) {
  const bbox = imageTaskWireRecord(value, message)
  assertImageTaskKeys(bbox, ['x', 'y', 'w', 'h'], [], message)
  if (
    !['x', 'y', 'w', 'h'].every(
      (key) => typeof bbox[key] === 'number' && Number.isFinite(bbox[key]),
    )
  ) {
    throw new Error(message)
  }
}

function assertImageTaskRecognizedQuestion(
  value: unknown,
  message: string,
): asserts value is RecognizedQuestion {
  const question = imageTaskWireRecord(value, message)
  assertImageTaskKeys(
    question,
    [
      'problem_id',
      'problem_kind',
      'page_asset_id',
      'question',
      'raw_transcription',
      'canonical_markdown',
      'canonical_valid',
      'canonical_version',
      'knowledge_points',
      'student_answer',
      'answer_canonical_valid',
      'answer_state',
      'confirmation_required',
      'confirmed_version',
    ],
    [
      'parent_problem_id',
      'subproblem_no',
      'attempt_id',
      'answer_raw_transcription',
      'answer_canonical_markdown',
      'subject',
      'recognition_confidence',
      'confirmation_reasons',
      'input_digest',
      'bbox',
    ],
    message,
  )
  if (
    typeof question.problem_id !== 'string' ||
    !IMAGE_TASK_PROBLEM_KINDS.has(question.problem_kind as ProblemKind) ||
    typeof question.page_asset_id !== 'string' ||
    typeof question.question !== 'string' ||
    typeof question.raw_transcription !== 'string' ||
    typeof question.canonical_markdown !== 'string' ||
    typeof question.canonical_valid !== 'boolean' ||
    !Number.isInteger(question.canonical_version) ||
    Number(question.canonical_version) < 1 ||
    !isImageTaskStringArray(question.knowledge_points) ||
    typeof question.student_answer !== 'string' ||
    typeof question.answer_canonical_valid !== 'boolean' ||
    !IMAGE_TASK_ANSWER_STATES.has(question.answer_state as AnswerState) ||
    typeof question.confirmation_required !== 'boolean' ||
    !Number.isInteger(question.confirmed_version) ||
    Number(question.confirmed_version) < 0
  ) {
    throw new Error(message)
  }
  for (const key of [
    'parent_problem_id',
    'subproblem_no',
    'attempt_id',
    'answer_raw_transcription',
    'answer_canonical_markdown',
    'subject',
    'input_digest',
  ]) {
    if (question[key] !== undefined && typeof question[key] !== 'string') {
      throw new Error(message)
    }
  }
  if (
    question.recognition_confidence !== undefined &&
    (typeof question.recognition_confidence !== 'number' ||
      !Number.isFinite(question.recognition_confidence))
  ) {
    throw new Error(message)
  }
  if (
    question.confirmation_reasons !== undefined &&
    (!Array.isArray(question.confirmation_reasons) ||
      !question.confirmation_reasons.every((reason) =>
        IMAGE_TASK_CONFIRMATION_REASONS.has(reason as OCRConfirmationReason),
      ))
  ) {
    throw new Error(message)
  }
  if (question.bbox !== undefined) assertImageTaskBBox(question.bbox, message)
}

function assertImageTaskGrade(value: unknown, message: string): asserts value is GradeResp {
  const grade = imageTaskWireRecord(value, message)
  assertImageTaskKeys(
    grade,
    [
      'solution',
      'verdict',
      'evidence_type',
      'badge',
      'out_of_scope',
      'record_created',
      'solve_only',
    ],
    ['wrong_step', 'error_cause', 'out_of_scope_kp', 'record_id', 'curriculum_unmapped'],
    message,
  )
  if (
    typeof grade.solution !== 'string' ||
    !IMAGE_TASK_GRADE_VERDICTS.has(grade.verdict as GradeVerdict) ||
    !IMAGE_TASK_EVIDENCE_TYPES.has(grade.evidence_type as EvidenceType) ||
    !IMAGE_TASK_GRADE_BADGES.has(grade.badge as GradeBadge) ||
    typeof grade.out_of_scope !== 'boolean' ||
    typeof grade.record_created !== 'boolean' ||
    typeof grade.solve_only !== 'boolean'
  ) {
    throw new Error(message)
  }
  for (const key of ['wrong_step', 'error_cause', 'out_of_scope_kp', 'record_id']) {
    if (grade[key] !== undefined && typeof grade[key] !== 'string') throw new Error(message)
  }
  if (
    grade.curriculum_unmapped !== undefined &&
    !isImageTaskStringArray(grade.curriculum_unmapped)
  ) {
    throw new Error(message)
  }
}

function assertImageTaskParentGuide(
  value: unknown,
  message: string,
): asserts value is ParentTeachingGuideDTO {
  const guide = imageTaskWireRecord(value, message)
  assertImageTaskKeys(
    guide,
    [
      'answer',
      'full_solution_steps',
      'grade_level_method',
      'likely_mistakes',
      'parent_teaching_sequence',
      'follow_up_questions',
      'checking_method',
    ],
    [],
    message,
  )
  if (
    typeof guide.answer !== 'string' ||
    !guide.answer.trim() ||
    !isImageTaskNonEmptyStringArray(guide.full_solution_steps) ||
    typeof guide.grade_level_method !== 'string' ||
    !guide.grade_level_method.trim() ||
    !isImageTaskNonEmptyStringArray(guide.likely_mistakes) ||
    !isImageTaskNonEmptyStringArray(guide.parent_teaching_sequence) ||
    !isImageTaskNonEmptyStringArray(guide.follow_up_questions) ||
    typeof guide.checking_method !== 'string' ||
    !guide.checking_method.trim()
  ) {
    throw new Error(message)
  }
}

function assertImageTaskPhotoPayload(
  value: ImageTaskWireRecord,
  intent: 'completed_homework' | 'blank_worksheet',
  message: string,
) {
  assertImageTaskKeys(
    value,
    ['mode', 'task_intent', 'result_surface', 'items', 'markdown', 'image_warning'],
    ['annotated_image'],
    message,
  )
  const expectedSurface =
    intent === 'completed_homework' ? 'annotated_homework' : 'parent_teaching_guide'
  if (
    (value.mode !== 'grade' && value.mode !== 'solve') ||
    value.task_intent !== intent ||
    value.result_surface !== expectedSurface ||
    !Array.isArray(value.items) ||
    typeof value.markdown !== 'string' ||
    typeof value.image_warning !== 'string'
  ) {
    throw new Error(message)
  }
  for (const itemValue of value.items) {
    const item = imageTaskWireRecord(itemValue, message)
    assertImageTaskKeys(
      item,
      ['question', 'status', 'result_kind'],
      ['warning', 'grade', 'parent_guide'],
      message,
    )
    assertImageTaskRecognizedQuestion(item.question, message)
    if (
      !IMAGE_TASK_PHOTO_STATUSES.has(item.status as PhotoJobItemDTO['status']) ||
      !IMAGE_TASK_PHOTO_RESULT_KINDS.has(item.result_kind as PhotoJobResultKind) ||
      (item.warning !== undefined && typeof item.warning !== 'string')
    ) {
      throw new Error(message)
    }
    if (item.grade !== undefined) assertImageTaskGrade(item.grade, message)
    if (item.parent_guide !== undefined) assertImageTaskParentGuide(item.parent_guide, message)

    if (intent === 'blank_worksheet') {
      if (
        item.status !== 'blank_solved' ||
        item.result_kind !== 'parent_teaching_guide' ||
        item.parent_guide === undefined
      ) {
        throw new Error(message)
      }
      continue
    }
    if (
      (item.status === 'correct' || item.status === 'wrong') &&
      (item.result_kind !== 'assessment' || item.grade === undefined)
    ) {
      throw new Error(message)
    }
    if (item.status === 'wrong' && item.parent_guide === undefined) throw new Error(message)
    if (item.status === 'correct' && item.parent_guide !== undefined) throw new Error(message)
  }
  if (value.annotated_image !== undefined) {
    const image = imageTaskWireRecord(value.annotated_image, message)
    assertImageTaskKeys(image, ['mime', 'data_base64', 'digest'], [], message)
    if (
      typeof image.mime !== 'string' ||
      !image.mime.trim() ||
      typeof image.data_base64 !== 'string' ||
      !image.data_base64.trim() ||
      typeof image.digest !== 'string' ||
      !image.digest.startsWith('sha256:')
    ) {
      throw new Error(message)
    }
  }
}

function assertImageTaskTarget(value: unknown) {
  const message = 'invalid image task dispatch response'
  const target = imageTaskWireRecord(value, message)
  assertImageTaskKeys(target, ['type', 'id'], [], message)
  if (
    (target.type !== 'homework_submission' && target.type !== 'creative_work_intake') ||
    typeof target.id !== 'string' ||
    !target.id.trim()
  ) {
    throw new Error(message)
  }
}

function assertImageTaskHomeworkProjection(value: ImageTaskWireRecord) {
  const message = 'invalid image task dispatch response'
  assertImageTaskKeys(
    value,
    ['kind', 'stage', 'confirmation_state', 'anchor_state'],
    ['recognition'],
    message,
  )
  if (
    value.kind !== 'homework' ||
    !IMAGE_TASK_HOMEWORK_STAGES.has(value.stage as ImageTaskHomeworkStage) ||
    (value.confirmation_state !== 'pending' && value.confirmation_state !== 'confirmed') ||
    !['pending', 'located', 'degraded'].includes(String(value.anchor_state))
  ) {
    throw new Error(message)
  }
  if (value.recognition !== undefined) {
    const recognition = imageTaskWireRecord(value.recognition, message)
    assertImageTaskKeys(recognition, ['questions'], ['subject'], message)
    if (
      !Array.isArray(recognition.questions) ||
      (recognition.subject !== undefined && typeof recognition.subject !== 'string')
    ) {
      throw new Error(message)
    }
    for (const question of recognition.questions) {
      assertImageTaskRecognizedQuestion(question, message)
    }
  }
}

function assertImageTaskCreativeProjection(value: ImageTaskWireRecord) {
  const message = 'invalid image task dispatch response'
  assertImageTaskKeys(
    value,
    ['kind', 'intake_id', 'work_type', 'status'],
    [
      'entry_kind',
      'promotion_policy',
      'routing_provenance',
      'commit_required',
      'commit_state',
      'promoted_work_id',
      'promoted_version_id',
      'canonical_version',
      'canonical_content',
      'conflicts',
      'work',
    ],
    message,
  )
  if (
    value.kind !== 'creative' ||
    typeof value.intake_id !== 'string' ||
    !value.intake_id.trim() ||
    (value.work_type !== 'writing' && value.work_type !== 'art') ||
    !IMAGE_TASK_CREATIVE_STATUSES.has(value.status as CreativeWorkIntakeStatus)
  ) {
    throw new Error(message)
  }
  if (
    (value.entry_kind !== undefined &&
      value.entry_kind !== 'auto' &&
      value.entry_kind !== 'new_work' &&
      value.entry_kind !== 'revision') ||
    (value.promotion_policy !== undefined &&
      value.promotion_policy !== 'automatic' &&
      value.promotion_policy !== 'explicit_commit') ||
    (value.routing_provenance !== undefined &&
      value.routing_provenance !== 'model_classified' &&
      value.routing_provenance !== 'parent_selected') ||
    (value.commit_required !== undefined && typeof value.commit_required !== 'boolean') ||
    (value.commit_state !== undefined &&
      value.commit_state !== 'pending' &&
      value.commit_state !== 'committed') ||
    (value.promoted_work_id !== undefined && typeof value.promoted_work_id !== 'string') ||
    (value.promoted_version_id !== undefined && typeof value.promoted_version_id !== 'string')
  ) {
    throw new Error(message)
  }
  if (
    (value.canonical_version !== undefined &&
      (!Number.isInteger(value.canonical_version) || Number(value.canonical_version) < 1)) ||
    (value.canonical_content !== undefined && typeof value.canonical_content !== 'string')
  ) {
    throw new Error(message)
  }
  if (value.conflicts !== undefined) {
    if (
      !Array.isArray(value.conflicts) ||
      !value.conflicts.every((conflict) => {
        const item = imageTaskWireRecord(conflict, message)
        assertImageTaskKeys(item, ['segment_id'], ['raw_text', 'canonical_text', 'reason'], message)
        return typeof item.segment_id === 'string' && !!item.segment_id.trim()
      })
    ) {
      throw new Error(message)
    }
  }
  if (value.work !== undefined) {
    const work = imageTaskWireRecord(value.work, message)
    assertImageTaskKeys(work, ['work_id', 'display_name'], [], message)
    if (
      typeof work.work_id !== 'string' ||
      !work.work_id.trim() ||
      typeof work.display_name !== 'string'
    ) {
      throw new Error(message)
    }
  }
}

function assertImageTaskStructuredFeedback(
  value: unknown,
  message: string,
): asserts value is ImageTaskStructuredFeedbackDTO {
  const feedback = imageTaskWireRecord(value, message)
  assertImageTaskKeys(
    feedback,
    [
      'feedback_id',
      'version_id',
      'feedback_type',
      'evidence_refs',
      'observations',
      'source_snapshot',
      'limitations',
      'suggestions',
      'projection_markdown',
    ],
    [],
    message,
  )
  if (
    typeof feedback.feedback_id !== 'string' ||
    !feedback.feedback_id.trim() ||
    typeof feedback.version_id !== 'string' ||
    !feedback.version_id.trim() ||
    (feedback.feedback_type !== 'writing' && feedback.feedback_type !== 'art') ||
    !isImageTaskStringArray(feedback.evidence_refs) ||
    !Array.isArray(feedback.observations) ||
    typeof feedback.limitations !== 'string' ||
    !isImageTaskStringArray(feedback.suggestions) ||
    typeof feedback.projection_markdown !== 'string' ||
    !feedback.projection_markdown.trim()
  ) {
    throw new Error(message)
  }
  for (const observationValue of feedback.observations) {
    const observation = imageTaskWireRecord(observationValue, message)
    assertImageTaskKeys(observation, ['dimension', 'evidence'], [], message)
    if (
      typeof observation.dimension !== 'string' ||
      !observation.dimension.trim() ||
      typeof observation.evidence !== 'string' ||
      !observation.evidence.trim()
    ) {
      throw new Error(message)
    }
  }
  const source = imageTaskWireRecord(feedback.source_snapshot, message)
  assertImageTaskKeys(source, ['source', 'method_ref', 'capability'], [], message)
  if (
    (source.source !== 'ai' && source.source !== 'parent') ||
    typeof source.method_ref !== 'string' ||
    typeof source.capability !== 'string'
  ) {
    throw new Error(message)
  }
}

function assertImageTaskDispatch(value: unknown): asserts value is ImageTaskDispatchDTO {
  const message = 'invalid image task dispatch response'
  const dispatch = imageTaskWireRecord(value, message)
  assertImageTaskKeys(
    dispatch,
    [
      'dispatch_id',
      'task_intent',
      'status',
      'intent_evidence',
      'intent_confidence',
      'confirmation_candidates',
      'progress',
      'version',
      'created_at',
      'updated_at',
    ],
    ['target', 'target_projection'],
    message,
  )
  if (
    typeof dispatch.dispatch_id !== 'string' ||
    !dispatch.dispatch_id.trim() ||
    !IMAGE_TASK_INTENTS.has(dispatch.task_intent as ImageTaskIntent) ||
    !IMAGE_TASK_STATUSES.has(dispatch.status as ImageTaskDispatchStatus) ||
    !isImageTaskStringArray(dispatch.intent_evidence) ||
    typeof dispatch.intent_confidence !== 'number' ||
    !Number.isFinite(dispatch.intent_confidence) ||
    !Array.isArray(dispatch.confirmation_candidates) ||
    !dispatch.confirmation_candidates.every((candidate) =>
      IMAGE_TASK_INTENTS.has(candidate as ImageTaskIntent),
    ) ||
    !Number.isInteger(dispatch.version) ||
    typeof dispatch.created_at !== 'number' ||
    !Number.isFinite(dispatch.created_at) ||
    typeof dispatch.updated_at !== 'number' ||
    !Number.isFinite(dispatch.updated_at)
  ) {
    throw new Error(message)
  }

  const progress = imageTaskWireRecord(dispatch.progress, message)
  assertImageTaskKeys(progress, ['operation', 'state'], [], message)
  if (
    !IMAGE_TASK_PROGRESS_OPERATIONS.has(progress.operation as ImageTaskProgressDTO['operation']) ||
    typeof progress.state !== 'string' ||
    !progress.state.trim()
  ) {
    throw new Error(message)
  }
  const validProgressState =
    (progress.operation === 'classification' &&
      IMAGE_TASK_STATUSES.has(progress.state as ImageTaskDispatchStatus)) ||
    (progress.operation === 'homework' &&
      IMAGE_TASK_HOMEWORK_STAGES.has(progress.state as ImageTaskHomeworkStage)) ||
    (progress.operation === 'writing_ocr' &&
      IMAGE_TASK_CREATIVE_STATUSES.has(progress.state as CreativeWorkIntakeStatus)) ||
    (progress.operation === 'promotion' &&
      (IMAGE_TASK_CREATIVE_STATUSES.has(progress.state as CreativeWorkIntakeStatus) ||
        IMAGE_TASK_CREATIVE_FEEDBACK_STATES.has(progress.state as ImageTaskCreativeFeedbackState)))
  if (!validProgressState) throw new Error(message)
  if (dispatch.target !== undefined) assertImageTaskTarget(dispatch.target)
  if (dispatch.target_projection !== undefined) {
    const projection = imageTaskWireRecord(dispatch.target_projection, message)
    if (projection.kind === 'homework') assertImageTaskHomeworkProjection(projection)
    else if (projection.kind === 'creative') assertImageTaskCreativeProjection(projection)
    else throw new Error(message)
  }
}

function assertImageTaskDispatchResp(value: unknown): asserts value is ImageTaskDispatchResp {
  const message = 'invalid image task dispatch response'
  const response = imageTaskWireRecord(value, message)
  assertImageTaskKeys(response, ['dispatch'], [], message)
  assertImageTaskDispatch(response.dispatch)
}

function assertImageTaskCreateResp(value: unknown): asserts value is ImageTaskCreateResp {
  const message = 'invalid image task dispatch response'
  const response = imageTaskWireRecord(value, message)
  assertImageTaskKeys(response, ['created', 'dispatch'], [], message)
  if (typeof response.created !== 'boolean') throw new Error(message)
  assertImageTaskDispatch(response.dispatch)
}

function assertImageTaskResultResp(value: unknown): asserts value is ImageTaskResultResp {
  const message = 'invalid image task result response'
  const response = imageTaskWireRecord(value, message)
  assertImageTaskKeys(response, ['dispatch_id', 'task_intent', 'status', 'result'], [], message)
  if (
    typeof response.dispatch_id !== 'string' ||
    !response.dispatch_id.trim() ||
    !IMAGE_TASK_INTENTS.has(response.task_intent as ImageTaskIntent) ||
    !IMAGE_TASK_STATUSES.has(response.status as ImageTaskDispatchStatus)
  ) {
    throw new Error(message)
  }
  if (response.result === null) return
  const result = imageTaskWireRecord(response.result, message)
  assertImageTaskKeys(result, ['kind', 'payload'], [], message)
  if (
    !['completed_homework', 'blank_worksheet', 'writing', 'artwork'].includes(
      String(result.kind),
    ) ||
    result.kind !== response.task_intent
  ) {
    throw new Error(message)
  }
  const payload = imageTaskWireRecord(result.payload, message)
  if (result.kind === 'completed_homework' || result.kind === 'blank_worksheet') {
    assertImageTaskPhotoPayload(payload, result.kind, message)
    return
  }
  assertImageTaskKeys(payload, ['intake'], ['work', 'feedback'], message)
  const intake = imageTaskWireRecord(payload.intake, message)
  assertImageTaskKeys(intake, ['intake_id', 'status'], [], message)
  if (
    typeof intake.intake_id !== 'string' ||
    !intake.intake_id.trim() ||
    !IMAGE_TASK_CREATIVE_STATUSES.has(intake.status as CreativeWorkIntakeStatus)
  ) {
    throw new Error(message)
  }
  if (payload.work !== undefined) {
    const work = imageTaskWireRecord(payload.work, message)
    assertImageTaskKeys(work, ['work_id', 'display_name'], [], message)
    if (
      typeof work.work_id !== 'string' ||
      !work.work_id.trim() ||
      typeof work.display_name !== 'string'
    ) {
      throw new Error(message)
    }
  }
  if (payload.feedback !== undefined) {
    const feedback = imageTaskWireRecord(payload.feedback, message)
    assertImageTaskKeys(feedback, ['structured_feedback', 'projection_markdown'], [], message)
    assertImageTaskStructuredFeedback(feedback.structured_feedback, message)
    if (
      typeof feedback.projection_markdown !== 'string' ||
      !feedback.projection_markdown.trim() ||
      feedback.projection_markdown !==
        (feedback.structured_feedback as ImageTaskStructuredFeedbackDTO).projection_markdown
    ) {
      throw new Error(message)
    }
  }
}

/** 固化原图资产后创建唯一图片任务；响应即回，不等待分类或子链完成。 */
export async function k12CreateImageTask(req: CreateImageTaskReq, signal?: AbortSignal) {
  const response = await apiPost<unknown>(`${BASE}/image-tasks`, req, {
    timeout: 60_000,
    signal,
  })
  assertImageTaskCreateResp(response)
  return response
}
/** 查询分流、公开子链停点与最小冲突；内部 invocation/provider 不在该 DTO 中。 */
export async function k12GetImageTask(agent: string, dispatchId: string, signal?: AbortSignal) {
  const response = await apiGet<unknown>(
    `${BASE}/image-tasks/${encodeURIComponent(dispatchId)}`,
    { agent },
    { signal },
  )
  assertImageTaskDispatchResp(response)
  return response
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
  assertImageTaskResultResp(response)
  return response
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
  assertImageTaskDispatchResp(response)
  return response
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
  assertImageTaskDispatchResp(response)
  return response
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
  assertImageTaskDispatchResp(response)
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

export type GenericPrintSourceKind = 'tutoring_tips' | 'practice_question' | 'practice_answer'

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
/** `archived` is a legacy read-only fact; Desktop no longer exposes an archive command. */
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
  /** `parent` is retained only to render historical feedback; new feedback is server-generated. */
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
/** 为已有点评追加一次生成；commandId 由调用方创建，重放同 ID 不得重复生成。 */
export function k12GenerateWorkFeedback(
  agent: string,
  recordId: string,
  commandId: string,
  signal?: AbortSignal,
) {
  return apiPost<CreativeWorkDTO>(
    `${BASE}/creative-works/${encodeURIComponent(recordId)}/generate-feedback`,
    { agent, command_id: commandId },
    { timeout: 240_000, signal },
  )
}
/** 提交修改稿形成新版本（feedback_ready → revised） */
export function k12SubmitWorkRevision(agent: string, recordId: string, contentMarkdown?: string) {
  return apiPost<CreativeWorkDTO>(`${BASE}/creative-works/${recordId}/revision`, {
    agent,
    content_markdown: contentMarkdown ?? '',
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
