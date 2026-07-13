/**
 * K12 家长备课助手后端契约（/api/k12/*）· 24 端点。
 * DTO 与后端 scenarios/k12/apihttp/handler.go 的 json tag 1:1 对齐（前端类型即契约）。
 *
 * 注意：K12 端点**不需要 user_id**，隔离键是 `agent`（= agents.name）。
 * 错误响应统一 {error: string}（语言不保证），由 client.ts normalizeApiError 提到 e.message。
 */
import { api, apiGet, apiPost, apiPut, apiDelete } from './client'

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

/** verdict：engine 只产 agree/disagree/unverifiable；out_of_scope 走独立布尔字段 */
export type GradeVerdict = 'agree' | 'disagree' | 'unverifiable' | 'out_of_scope'
/** 徽章枚举（后端 usecase/evidence.go Badge()） */
export type GradeBadge = 'verified-strong' | 'verified-weak' | 'disagree' | 'out-of-scope' | 'unverifiable'
export type EvidenceType = 'numeric_exec' | 'symbolic_exec' | 'heterogeneous_model' | 'heuristic' | 'none'

export interface GradeResp {
  solution: string
  verdict: GradeVerdict
  evidence_type: EvidenceType
  badge: GradeBadge
  correct: boolean
  wrong_step?: string
  error_cause?: string
  out_of_scope: boolean
  out_of_scope_kp?: string
  record_created: boolean
  record_id?: string
  /** true = student_answer 为空，后端内部转「解题」分叉（非批改）：只给 solution，
   *  correct/record 无意义。前端应按解题口径呈现，不显对/错、不显入本。 */
  solve_only?: boolean
}

export function k12Grade(req: GradeReq) {
  // LLM 验算链，默认 30s 会腰斩（BUG-20260712-T1）
  return apiPost<GradeResp>(`${BASE}/grade`, req, { timeout: 120_000 })
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
  // 解题验算链同 grade，默认 30s 会腰斩（BUG-20260712-T1）
  return apiPost<SolveResp>(`${BASE}/solve`, req, { timeout: 120_000 })
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
  /** 相似题 + 解答（给家长核对，先别给孩子看；守答案遮罩） */
  solution: string
  /** solve 验算裁决：agree/disagree/unverifiable/out_of_scope */
  verdict: string
  /** 验算徽章文案 */
  badge: string
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

/** source_label 是带 emoji 的中文串（📖 依据课本 / 🤖 AI 归纳·供参考（未校验）/ 🗂 本地记录 / ✅ 已程序验算 / 🧠 学情信号） */
export interface PrepSectionDTO {
  title: string
  content: string
  source_label: string
}

export interface PrepCardResp {
  knowledge_points: string[]
  sections: PrepSectionDTO[]
}

export function k12PrepCard(req: PrepCardReq) {
  // LLM 生成辅导要点，默认 30s 会腰斩→「Fetch is aborted」（BUG-20260712-T1 真机取证）
  return apiPost<PrepCardResp>(`${BASE}/prep-card`, req, { timeout: 120_000 })
}

// ── study-time（学习时长，一维按日；无 period/学科维度）──────
export interface StudyDay {
  date: string
  record_count: number
  estimated_minutes: number
}
export interface StudyTimeResp {
  days: StudyDay[] | null
  total_records: number
  total_minutes: number
  note: string
}
export function k12StudyTime(agent: string) {
  return apiGet<StudyTimeResp>(`${BASE}/study-time`, { agent })
}

// ── insight-report（学情报告）────────────────────────────────
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
  return apiGet<{ items: AccumDTO[] }>(`${BASE}/accumulation`, subject ? { agent, subject } : { agent })
}
export function k12AddAccumulation(req: AddAccumReq) {
  return apiPost<{ record_id: string; created: boolean }>(`${BASE}/accumulation`, req)
}

// ── backup / restore（真实 .hexbak，服务端带 checksum）──────
export interface HexbakArchive {
  version: number
  agent_name: string
  exported_at: number
  profile?: ProfileDTO | null
  records: unknown[]
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
export function renderDocument(req: RenderReq): Promise<Blob> {
  return api<Blob, 'blob'>('/api/v1/render', {
    method: 'POST', body: req, responseType: 'blob', timeout: 120_000,
  })
}

// 注：GET /mistake-sheet 的前端客户端已删除——前端错题卷由客户端 printWorksheet 生成（当前视图错题
// → A4 iframe 打印），后端周错题卷 md 仅供 cron 投递用（审计 #7 冗余死绑定清理）。

// ── recognize（拍题识题：作业图片 → 结构化题目清单，需 LLM）──────
/**
 * 学生作答区域的归一化边界框（0~1），随识题一次返回，供前端在原图上叠加确定性批改标记（✓/✗）。
 * x,y=框左上角，w,h=框宽高，全部相对整图宽/高的比例（对标作业帮/小猿的「检测坐标 + 程序叠加」范式）。
 * 缺失/null = 该题未定位（视觉模型未给/坐标非法）→ 前端降级为纯文字批改，绝不叠加错位红叉。
 */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}
export interface RecognizedQuestion {
  question: string
  knowledge_points: string[]
  /** 识题回收的孩子手写作答（未作答=空串/缺省）。前端据此区分空白题(走 /solve 求解)与
   *  已答题(走 /grade 批改)，并预填到作答框供家长核对/修改。 */
  student_answer?: string
  /** 识题自动判定的题目学科（数学/语文/英语/物理/化学，判不出=空/缺省）。 */
  subject?: string
  /** 学生作答区域归一化边界框（0~1）；缺失/null=未定位（降级纯文字批改，不叠加）。 */
  bbox?: BBox | null
}
/** 识题响应：题目清单 + 整卷学科（逐题判定取多数，供前端预填学科下拉，家长仍可手动覆盖）。 */
export interface RecognizeResp {
  questions: RecognizedQuestion[]
  /** 整卷学科（家长不必手选）；识题一科都判不出时为空/缺省。 */
  subject?: string
}
/**
 * 作业图片 → 题目清单。image_base64 可带或不带 data:image/...;base64, 前缀（后端会剥）。
 * 识题回显护栏：拿到 questions 后前端展示让家长核对/纠正，确认后再逐题 grade。
 */
export function k12Recognize(imageBase64: string) {
  // 视觉识题（全量题目 JSON 生成），默认 30s 必被腰斩 abort（BUG-20260712-T1 真机取证「识题很慢/卡住」）
  return apiPost<RecognizeResp>(`${BASE}/recognize`, { image_base64: imageBase64 }, { timeout: 180_000 })
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
  return apiPost<{ bound: boolean; agent: string; platform: string; chat_id: string }>(`${BASE}/bind-im`, req)
}

// ── cron/provision（注册 5 个默认自动化任务）──────────────────
export interface ProvisionCronReq {
  agent: string
  /** 投递到的 IM 平台；空 → 桌面 chat */
  platform?: string
  chat_id?: string
  /** 投递目标；空 → 平台默认 chat */
  deliver?: string[]
  /** cron 配额归属；空 → "k12" */
  user_id?: string
  /** 本机 API 基址；服务器已配 Runtime.BaseURL 时可省 */
  base_url?: string
}
export interface ProvisionedJob {
  kind: string
  name: string
  schedule: string
  job_id: string
}
/** 建档后调一次；未注入 cron.Scheduler → 501 */
export function k12ProvisionCron(req: ProvisionCronReq) {
  return apiPost<{ provisioned: ProvisionedJob[] }>(`${BASE}/cron/provision`, req)
}
