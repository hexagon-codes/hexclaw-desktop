<script setup lang="ts">
/**
 * K12 错题本 / 积累本 / 学情（features/k12）· M1-6 记录视图 + M3-6 复习引擎 + M3-7 学情报告。
 *
 * 复用通用 shell 的 RecordList（schema 驱动），本组件只提供 K12 数据接线 + 场景专属动作
 * （出错题卷 / 导出 / 备份）+ 学情聚合。多孩隔离 = 以 agentId 拉取，切实例即换数据。
 */
import { computed, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import RecordList from '@/shell/records/RecordList.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useToast } from '@/composables/useToast'
import { setClipboard } from '@/api/desktop'
import { useK12Store } from '../store'
import K12PracticeSetsPanel from './K12PracticeSetsPanel.vue'
import K12CreativeWorksPanel from './K12CreativeWorksPanel.vue'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'
import { k12ReviewRetry, k12ExportMd, k12AddAccumulation, k12AddToBasket } from '@/api/k12'
// 积累「生成默写题加入练习集」端点未收编进 api/k12.ts（该文件其他会话活跃禁改）→ 暂用 apiPost 内联，
// TODO：待 api/k12.ts 解锁后收编为 k12AccumDictationToBasket。
import { apiPost } from '@/api/client'
import { MISTAKE_SCHEMA, ACCUMULATION_SCHEMA } from '../schemas'
import { exportPdf, exportWord, worksheetFilename, download } from '../export'
import type { RecordItem } from '@/contracts'

const props = defineProps<{
  agentId: string
  agentName: string
  grade: string
}>()

const emit = defineEmits<{
  (e: 'go-tutor'): void
  (e: 'go-insights'): void
  (e: 'open-backup'): void
}>()

const { t } = useI18n()
const toast = useToast()
const store = useK12Store()

// IA 定稿（PRD §1.5，2026-07-18 迁移）：学习档案五对象 Tab——本周复习(行动)｜全部错题(档案)｜
// 练习集｜积累｜作品；学情已提升为顶栏一等 Tab（K12InsightPanel）。默认落在「本周复习」（行动优先）。
const sub = ref<'week' | 'mistakes' | 'practiceSets' | 'accumulation' | 'works'>('week')

// 积累本分科过滤（#5）：''=全部 / '语文' / '英语'，触达后端 GET /accumulation?subject=（BUG-3）。
const accumSubject = ref('')
async function reloadAccum() {
  await store.loadAccumulation(props.agentId, accumSubject.value || undefined)
}
function setAccumSubject(s: string) {
  if (accumSubject.value === s) return
  accumSubject.value = s
  reloadAccum()
}

async function reload() {
  if (!props.agentId) return
  await Promise.all([
    store.loadMistakes(props.agentId),
    store.loadReport(props.agentId), // trend pill（本周复习行动卡）数据源；学情全量在 K12InsightPanel
    reloadAccum(),
  ])
}
onMounted(reload)
// 切实例（多孩）→ 重置分科过滤 + 收起记录表单 + 清庆祝态，避免带上一个孩子的会话态
watch(() => props.agentId, () => { accumSubject.value = ''; accumAddOpen.value = false; clearedThisSession.value = false; reload() })

// 手动记积累本（#4）：家长在会话里遇到好东西 → 直接记进积累本（PRD §3.13）。
// 学情相关（本月辅导次数/学期分科/薄弱条/完成率）已随 IA 迁移抽到 K12InsightPanel（顶栏一等 Tab）。

// 20260718 原型定案对齐（app.html K12_ACCUMULATION_TYPES）：类型按学科分化——语文收好词好句/
// 古诗积累/写作素材，英语收表达积累/词汇积累；原静态四项混排会出现「英语 × 古诗」无效组合。
// 切学科时类型重置为该学科首项；展示侧兼容存量旧词汇（见 store ACCUM_KEEP_TYPES）。
const ACCUM_SUBJECTS = ['语文', '英语']
const ACCUM_TYPES_BY_SUBJECT: Record<string, string[]> = {
  语文: ['好词好句', '古诗积累', '写作素材'],
  英语: ['表达积累', '词汇积累'],
}
const accumAddOpen = ref(false)
const accumForm = ref({ subject: '语文', entry_type: '好词好句', content: '' })
// HcSelect 选项（原生 select 在 WKWebView 显 macOS Aqua 样式 · BUG-20260708 D5/B2）
const accumSubjectOptions = computed(() => ACCUM_SUBJECTS.map((s) => ({ value: s, label: s })))
const accumTypeOptions = computed(() =>
  (ACCUM_TYPES_BY_SUBJECT[accumForm.value.subject] ?? ACCUM_TYPES_BY_SUBJECT['语文']!).map((ty) => ({ value: ty, label: ty })),
)
watch(
  () => accumForm.value.subject,
  (s) => {
    accumForm.value.entry_type = (ACCUM_TYPES_BY_SUBJECT[s] ?? ACCUM_TYPES_BY_SUBJECT['语文']!)[0]!
  },
  // sync：学科一变立即重置类型；pre-flush 会在「同 tick 先选学科再选类型」时反过来冲掉用户的类型选择
  { flush: 'sync' },
)
const accumSaving = ref(false)
async function submitAccum() {
  const content = accumForm.value.content.trim()
  if (!content || accumSaving.value) return
  accumSaving.value = true
  try {
    await k12AddAccumulation({
      agent: props.agentId,
      subject: accumForm.value.subject,
      entry_type: accumForm.value.entry_type,
      content,
    })
    toast.success(t('k12.accum.added'))
    accumForm.value.content = ''
    accumAddOpen.value = false
    await reloadAccum()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    accumSaving.value = false
  }
}

// 手工录入错题（20260709 / BUG-20260712 治本）：课堂/学校/线下没经过 App 的错题也能进本子（错题本价值=完整性）。
// 家长手动记的是**已知错题**——直接走轻量 record-mistake 端点直录（题目+答案入库 + 单次轻量错因归纳），
// 绝不复用 store.grade 的 solve+verify 对抗验算链（那是「不知道对不对」才要跑，真机 1-2 分钟）；秒级完成。
const mistakeAddOpen = ref(false)
const mistakeForm = ref({ subject: '', problem: '', studentAnswer: '', knowledgePoints: '' })
const mistakeSubjectOptions = computed(() => K12_GRADE_SUBJECT_OPTIONS.map(({ value, labelKey }) => ({
  value,
  label: t(labelKey),
})))
const mistakeSaving = ref(false)
// textarea 内 Enter=换行；⌘/Ctrl+Enter 提交（20260712 视觉评审定案，与桌面输入习惯一致）
function onMistakeKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    void submitMistake()
  }
}
async function submitMistake() {
  const problem = mistakeForm.value.problem.trim()
  if (!mistakeForm.value.subject || !problem || mistakeSaving.value) return
  mistakeSaving.value = true
  try {
    const kps = mistakeForm.value.knowledgePoints
      .split(/[·,，、/]/).map((s) => s.trim()).filter(Boolean)
    const res = await store.recordMistake({
      agent: props.agentId,
      subject: mistakeForm.value.subject,
      grade: props.grade,
      problem,
      student_answer: mistakeForm.value.studentAnswer.trim() || undefined,
      knowledge_points: kps.length ? kps : undefined,
    })
    toast.success(res.record_created ? t('k12.mistakeAdd.recorded') : t('k12.mistakeAdd.exists'))
    mistakeForm.value = { subject: '', problem: '', studentAnswer: '', knowledgePoints: '' }
    mistakeAddOpen.value = false
    await store.loadMistakes(props.agentId)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    mistakeSaving.value = false
  }
}

// ── 组卷改道装篮（§3.6/§3.8 闭环断裂修复 · 原型 buildVerifiedPracticeSet 购物车模型）──
// 「生成复习卷 / 自定义组卷」不再客户端 exportPdf 直出 PDF（绕过练习集=闭环断裂）：
// 统一为「装篮」——逐题 AddToBasket（幂等去重），打印/发送在练习集完成（打印即确认固化）。
// 原题重现暂无独立验算答案 → verification_status 诚实置 'pending'（后端验证后转 verified/blocked）。
// TODO(§4.7)：语文/英语 verbatim 类「题面即答案」，可由字符校验直判 verified——待后端语义拆分后特判。
const basketBusy = ref(false)
async function addRecordsToBasket(records: RecordItem[], via: 'weekly' | 'custom') {
  let added = 0
  let deduped = 0
  for (const rec of records) {
    const resp = await k12AddToBasket({
      agent: props.agentId,
      item: {
        item_id: '',
        source_problem_id: rec.recordId,
        subject: typeof rec.fields.subject === 'string' ? rec.fields.subject : '',
        added_via: via,
        question_markdown: String(rec.fields.question ?? ''),
        verification_status: 'pending',
      },
    })
    if (resp.added) added++
    else deduped++
  }
  return { added, deduped }
}
/** 复习队列对应的到期记录（顺序按队列） */
function reviewQueueRecords(): RecordItem[] {
  const v = view.value
  if (!v?.reviewQueue?.length) return []
  const byId = new Map(v.items.map((i) => [i.recordId, i]))
  return v.reviewQueue.map((id) => byId.get(id)).filter((r): r is RecordItem => !!r)
}
/** 「生成复习卷」主动作：本周待复习批量装篮 → toast 结果 + 切到练习集 Tab */
async function buildReviewSet() {
  if (basketBusy.value) return
  const records = reviewQueueRecords()
  if (!records.length) return
  basketBusy.value = true
  try {
    const { added, deduped } = await addRecordsToBasket(records, 'weekly')
    toast.success(t('k12.records.basketBatchAdded', { n: added, m: deduped }))
    sub.value = 'practiceSets'
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    basketBusy.value = false
  }
}

// 自定义组卷（20260709 渐进披露 / 20260718 改道装篮）：主动作保持零配置智能默认；想微调的少数家长
// 走此次级面板。范围先做两档（本周待复习 / 全部未掌握）；`total` 客户端切片限量可兑现；
// `perQ`(每题变式数)/`difficulty`(难度)需后端组卷端点按参数出变式题，客户端装原题无法兑现（契约缺口，UI 先留参数）。
const customPaperOpen = ref(false)
const paperForm = ref({ scope: 'week', perQ: '1', difficulty: 'same', total: 'all' })
const paperScopeOpts = computed(() => [
  { v: 'week', label: t('k12.customPaper.scopeWeek') },
  { v: 'unmastered', label: t('k12.customPaper.scopeUnmastered') },
])
const paperPerQOpts = ['1', '2', '3']
const paperDiffOpts = computed(() => [
  { v: 'same', label: t('k12.customPaper.diffSame') },
  { v: 'easier', label: t('k12.customPaper.diffEasier') },
  { v: 'harder', label: t('k12.customPaper.diffHarder') },
])
const paperTotalOpts = computed(() => [
  { v: 'all', label: t('k12.customPaper.totalAll') },
  { v: '5', label: '≤ 5' },
  { v: '10', label: '≤ 10' },
])
async function genCustomPaper() {
  if (basketBusy.value) return
  customPaperOpen.value = false
  // 范围取材：本周待复习=复习队列到期项；全部未掌握=档案里未掌握/未归档全量。
  const source =
    paperForm.value.scope === 'week'
      ? reviewQueueRecords()
      : (view.value?.items ?? []).filter((i) => i.status !== 'mastered' && i.status !== 'archived')
  const limit = paperForm.value.total === 'all' ? source.length : Number(paperForm.value.total)
  const records = source.slice(0, limit)
  if (!records.length) return
  basketBusy.value = true
  try {
    const { added, deduped } = await addRecordsToBasket(records, 'custom')
    toast.success(t('k12.records.basketBatchAdded', { n: added, m: deduped }))
    sub.value = 'practiceSets'
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    basketBusy.value = false
  }
}

const view = computed(() => store.mistakeView)
const accumView = computed(() => store.accumView)
const report = computed(() => store.report)

// 项-5：空态设计——复习队列（本周复习）常空时不留尴尬空白。
// 折叠机制随旧两段 IA 退役（2026-07-18）：本周复习=行动页（hide-list）、全部错题=档案页（hide-review），
// 不再有「档案折叠在行动卡下方」的形态。
const hasReviewQueue = computed(() => (view.value?.reviewQueue?.length ?? 0) > 0)
// 下次到期复习（未到期错题里最近一条）——空态卡给家长「都在计划里·稳步消化」的确定感。
const nextReview = computed(() => {
  const items = view.value?.items ?? []
  const now = Date.now() / 1000
  const first = items
    .filter((i) => typeof i.dueAt === 'number' && (i.dueAt as number) > now)
    .sort((a, b) => (a.dueAt as number) - (b.dueAt as number))[0]
  if (!first) return null
  const d = new Date((first.dueAt as number) * 1000)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const kp = String(first.fields.knowledge_point ?? '').replace(/[·・]\s*$/, '').trim()
  return { record: first, date, kp }
})
// 温和次级 CTA「提前练一练」：复用最近到期（或第一条）错题触发再练弹层。
function practiceEarly() {
  const rec = nextReview.value?.record ?? view.value?.items?.[0]
  if (rec) void doRetry(rec)
}

// 本周清零庆祝态（§3.6 / 原型 k12WeekClearState）：清零是一周唯一的正反馈时刻——
// 空态区分「本轮有做对清零」（庆祝）vs「本来就无到期」（中性计划文案）。
// DTO 无状态变更时间戳（无法判「今天 retried/mastered」），先以会话内清零动作近似：
// 本会话「家长确认已会」把队列里的题清掉且队列随之清空 → 庆祝。TODO：后端下发 updated_at 后改为按日判定。
const clearedThisSession = ref(false)
const weekCleared = computed(() => !hasReviewQueue.value && clearedThisSession.value)
function isInReviewQueue(recordId: string): boolean {
  return view.value?.reviewQueue?.includes(recordId) ?? false
}

// 原型 c8a194e：「本周复习」标题带跨科分布（数学 2 · 语文 1 · 英语 1）。
// 只统计队列里 subject 已知的行（chip=「学科·知识点」，review-queue 契约下发 subject）；
// 全部未知 → 空串不显括号（诚实降级，/mistakes 列表 subject 是 P2 缺口）。
const reviewSubjectDist = computed(() => {
  const v = view.value
  if (!v?.reviewQueue?.length) return ''
  const byId = new Map(v.items.map((i) => [i.recordId, i]))
  const counts = new Map<string, number>()
  for (const id of v.reviewQueue) {
    const kp = String(byId.get(id)?.fields.knowledge_point ?? '')
    const dot = kp.indexOf('·')
    if (dot > 0) {
      const s = kp.slice(0, dot)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
  }
  if (!counts.size) return ''
  return [...counts.entries()].map(([s, n]) => `${s} ${n}`).join(' · ')
})

// 原型 c8a194e + PRD §3.5.7：趋势 pill 并入行动卡。语义=「仅确有进步才用绿系」——
// 有已掌握沉淀（trend.mastered>0）→ 绿「趋势 ↑ 在进步」，否则琥珀「趋势 → 待巩固」（非成功绿）。
const trendPill = computed(() => {
  const tr = report.value?.trend
  if (!tr || !tr.total) return null
  return tr.mastered > 0
    ? { label: t('k12.records.trendUp'), up: true }
    : { label: t('k12.records.trendFlat'), up: false }
})

// 复习完成率/薄弱条已随 IA 迁移抽到 K12InsightPanel（学情=顶栏一等 Tab）。

async function onAction(payload: { id: 'practiceAgain' | 'markMastered' | 'detail'; record: RecordItem }) {
  const { id, record } = payload
  if (id === 'markMastered') {
    try {
      // §4.11 信任链：按钮语义=「家长确认已会」（parent confirmation），非系统「已掌握」；
      // toast 不得宣称已掌握（后端语义拆分另一包，这里只守文案口径）。
      const wasInQueue = isInReviewQueue(record.recordId) // reload 前取值（store.markMastered 内含 reload）
      await store.markMastered(props.agentId, record.recordId, record.version)
      if (wasInQueue) clearedThisSession.value = true // 本轮清零动作 → 队列清空时亮庆祝态（§3.6）
      toast.success(t('k12.records.masteredToast'))
    } catch (e) {
      // 409 版本冲突：并发改动，刷新后重试
      toast.error(e instanceof Error ? e.message : String(e))
      await reload()
    }
  } else if (id === 'practiceAgain') {
    void doRetry(record)
  } else if (id === 'detail') {
    openDetail(record)
  }
}

// 「再练一道」变式题结果弹层（守答案真遮罩：revealed=false 时答案模糊+禁选中，点按才揭示）。
// UX-2：再练结果**展示**不含验算徽章（练习题非批改）；badge 仅内部保留供装篮定级（§3.8 入口1），不渲染。
// 题答分离（2026-07-18 P2 清偿）：question=题面（先显给孩子做）、answer=解答（默认遮罩）、
// expectedAnswer=最终答案（装篮 expected_answer_markdown 用）；后端拆不出时三者为空 → 整段遮罩回退。
const retry = ref<{ open: boolean; loading: boolean; error: boolean; solution: string; question: string; answer: string; expectedAnswer: string; badge: string; revealed: boolean; basketed: boolean }>({
  open: false,
  loading: false,
  error: false,
  solution: '',
  question: '',
  answer: '',
  expectedAnswer: '',
  badge: '',
  revealed: false,
  basketed: false,
})
// BUG-20260712-#4：再练取消守卫——generation 使在途请求结果失效（防幽灵重开），AbortController 中止后台出题。
let retryGen = 0
let retryAbort: AbortController | null = null
// BUG-20260712-#1：记住最近一次再练的错题，失败态「重试」按钮据此重发（不静默关弹层）。
const retryRecord = ref<RecordItem | null>(null)

// 「再练一道」：调 POST /review/retry 出同知识点相似题（过 solve 验算链，真机实测 ~68s）。
// 原型终态=变式直接入本周复习卷不亮答案；当前后端 retry 无持久化且 solution 题答混排（P2 缺口），
// 过渡为「真遮罩弹层」：答案默认模糊不可选中，家长明确点「显示答案」才揭示——守答案承诺交互兑现。
// BUG-20260712-#4：关弹窗时 abort 中止后台 + generation 守卫丢弃过期结果（关了不空烧算力/不幽灵重开）。
// BUG-20260712-#1：68s 长请求——loading 显明确进度文案；失败/超时保持弹层 open 给可重试提示，不静默关。
async function doRetry(record: RecordItem) {
  retryRecord.value = record
  const gen = ++retryGen
  retryAbort?.abort()
  retryAbort = new AbortController()
  retry.value = { open: true, loading: true, error: false, solution: '', question: '', answer: '', expectedAnswer: '', badge: '', revealed: false, basketed: false }
  try {
    const res = await k12ReviewRetry({ agent: props.agentId, record_id: record.recordId, grade: props.grade }, retryAbort.signal)
    if (gen !== retryGen) return // 已被关闭/取代 → 丢弃，不重开弹窗
    retry.value = {
      open: true, loading: false, error: false, solution: res.solution,
      question: res.question ?? '', answer: res.answer ?? '', expectedAnswer: res.expected_answer ?? '',
      badge: res.badge ?? '', revealed: false, basketed: false,
    }
  } catch {
    if (gen !== retryGen) return // 主动取消/已过期 → 静默
    // 失败/超时不静默关弹层：保留弹层 + 显友好可重试提示（原始技术串对家长无价值，故不透出）。
    retry.value = { open: true, loading: false, error: true, solution: '', question: '', answer: '', expectedAnswer: '', badge: '', revealed: false, basketed: false }
  }
}
function closeRetry() {
  retryGen++
  retryAbort?.abort()
  retryAbort = null
  retry.value = { open: false, loading: false, error: false, solution: '', question: '', answer: '', expectedAnswer: '', badge: '', revealed: false, basketed: false }
}

async function copyRetrySolution() {
  if (!retry.value.revealed || !retry.value.solution) return
  try {
    // 复制原始 Markdown，粘贴到钉钉/笔记时仍保留标题、列表和公式结构。
    await setClipboard(retry.value.solution)
    toast.success(t('k12.records.retryCopied'))
  } catch {
    toast.error(t('k12.records.retryCopyFailed'))
  }
}

// 「加入练习集」装篮（§3.8 入口1：错题再练一道逐题装）。变式题装入待打印篮：
// badge=verified-strong 且学科验证器达质量门（数学/语英，§4.7）→ verified；否则诚实置 pending
// （后端 AddToBasket 创建入口有质量门双拦截，前端先本地判一致避免 4xx）。
// P2 清偿（2026-07-18）：后端题答已分离——装篮用拆分题面 + expected_answer；
// 拆不出（question 空）时回退全文（老口径，最小闭环）。
const BASKET_GATE_SUBJECTS = new Set(['数学', '语文', '英语', ''])
async function addRetryToBasket() {
  const rec = retryRecord.value
  if (!rec || !retry.value.solution || retry.value.basketed) return
  const subject = typeof rec.fields?.subject === 'string' ? rec.fields.subject : ''
  const gated = BASKET_GATE_SUBJECTS.has(subject)
  const verifiedStrong = retry.value.badge === 'verified-strong' && gated
  try {
    const resp = await k12AddToBasket({
      agent: props.agentId,
      item: {
        item_id: '',
        source_problem_id: rec.recordId,
        subject,
        added_via: 'single_variant',
        question_markdown: retry.value.question || retry.value.solution,
        expected_answer_markdown: retry.value.expectedAnswer || undefined,
        verification_status: verifiedStrong ? 'verified' : 'pending',
        verification_evidence: verifiedStrong ? '独立验算' : undefined,
      },
    })
    retry.value.basketed = true
    toast.success(resp.added ? t('k12.records.basketAdded') : t('k12.records.basketDuplicate'))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

// ── 详情弹层（BUG-20260712-#2）──
// 复用列表已有的 RecordItem 字段，不额外请求后端，弹层可关闭。kind 区分错题（题目/知识点/错因）
// 与积累（内容/学科/类型），走各自 schema 状态机上色。
const detail = ref<{ open: boolean; record: RecordItem | null; kind: 'mistake' | 'accum' }>({ open: false, record: null, kind: 'mistake' })
function openDetail(record: RecordItem, kind: 'mistake' | 'accum' = 'mistake') {
  detail.value = { open: true, record, kind }
}
function closeDetail() {
  detail.value = { open: false, record: null, kind: 'mistake' }
}
const detailQuestion = computed(() => String(detail.value.record?.fields.question ?? ''))
const detailKp = computed(() => String(detail.value.record?.fields.knowledge_point ?? ''))
const detailError = computed(() => String(detail.value.record?.fields.error_cause ?? ''))
// 抽查复验（§3.6 规则 4）：复验未过的题在档案留「家长确认（复验未过）」事实标注——
// 只呈现 failed；scheduled/passed 不呈现（不打抽查标签、不制造紧张感）。话术温和不指责。
const detailSpotCheckFailed = computed(() => detail.value.record?.fields.spot_check_state === 'failed')
// 积累本字段
const detailContent = computed(() => String(detail.value.record?.fields.content ?? ''))
const detailAccumSubject = computed(() => String(detail.value.record?.fields.subject ?? ''))
const detailAccumType = computed(() => String(detail.value.record?.fields.entry_type ?? ''))
// 收藏日期（原型 acc-date）：fields.created_at（unix 秒字符串）→ MM-DD；旧后端无字段时不显示
function accumDate(item: RecordItem): string {
  const ts = Number(item.fields.created_at ?? '')
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function accumField(item: RecordItem, key: 'subject' | 'entry_type' | 'content' | 'source'): string {
  return String(item.fields[key] ?? '')
}
function accumSourceLabel(item: RecordItem): string {
  const source = accumField(item, 'source')
  return source ? `${t('k12.accumulationFields.source')}：${source}` : ''
}
function accumStatusLabel(item: RecordItem): string {
  return item.status === '已掌握' || item.status === 'mastered'
    ? t('k12.mistakeStatus.mastered')
    : t('k12.accumulationStatus.na')
}
function accumStatusTone(item: RecordItem): 'got' | 'na' {
  return item.status === '已掌握' || item.status === 'mastered' ? 'got' : 'na'
}
const detailStatus = computed(() => {
  const s = detail.value.record?.status
  if (!s) return '—'
  const schema = detail.value.kind === 'accum' ? ACCUMULATION_SCHEMA : MISTAKE_SCHEMA
  const st = schema.states?.find((x) => x.id === s)
  return st ? t(st.labelKey) : s
})
// 状态色调复用对应 schema 状态机声明（与 RecordList 行内状态徽章同源，零硬编码色映射）。
const detailStatusTone = computed(() => {
  const s = detail.value.record?.status
  const schema = detail.value.kind === 'accum' ? ACCUMULATION_SCHEMA : MISTAKE_SCHEMA
  return schema.states?.find((st) => st.id === s)?.tone ?? 'na'
})
// UX-1：详情弹层「家长确认已会」——已掌握态不显该动作（幂等，与档案行同口径）。
const detailMastered = computed(() => detail.value.record?.status === 'mastered')
async function markMasteredFromDetail() {
  const rec = detail.value.record
  if (!rec) return
  try {
    const wasInQueue = isInReviewQueue(rec.recordId) // reload 前取值
    await store.markMastered(props.agentId, rec.recordId, rec.version)
    if (wasInQueue) clearedThisSession.value = true // 本轮清零动作 → 庆祝态（§3.6）
    // 情绪峰值时刻：toast 说清结果（家长确认口径，§4.11）；store.markMastered 内已 reload 列表。
    toast.success(t('k12.records.masteredToast'))
    closeDetail()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e)) // 409 版本冲突：刷新后重试
    await reload()
  }
}

// §3.9 检验出口（原型 openAccumulationDetail 三出口之一）：积累详情「生成默写题，加入练习集」——
// 复制/发送是素材取用（不污染闭环），想检验记没记住走此出口（added_via=accumulation，后端生成默写题装篮）。
// 端点契约（后端另一 agent 在做，先按约定接）：POST /accumulation/{id}/dictation-to-basket → { record_id, added }。
// api/k12.ts 其他会话活跃禁改 → apiPost 内联，TODO 待解锁后收编为 k12AccumDictationToBasket。
const dictationBusy = ref(false)
const dictationAdded = ref<string[]>([]) // 本会话已装篮的积累 record_id（按钮幂等置灰）
async function dictationToBasket() {
  const rec = detail.value.record
  if (!rec || dictationBusy.value || dictationAdded.value.includes(rec.recordId)) return
  dictationBusy.value = true
  try {
    const resp = await apiPost<{ record_id: string; added: boolean }>(
      `/api/k12/accumulation/${rec.recordId}/dictation-to-basket`,
      { agent: props.agentId },
    )
    dictationAdded.value = [...dictationAdded.value, rec.recordId]
    toast.success(resp.added ? t('k12.records.basketAdded') : t('k12.records.basketDuplicate'))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    dictationBusy.value = false
  }
}

// UX-3：详情弹层内「删除这条错题」——克制入口（非首屏主按钮）+ 二次确认（复用 ConfirmDialog）。
// 用于移除记错的 / 重复的条目（数据纠错，非逃避难题）。删成功 → 关弹层 + reload + toast。
const confirmDelete = ref(false)
const deleting = ref(false)
function askDelete() { confirmDelete.value = true }
async function doDelete() {
  const rec = detail.value.record
  if (!rec || deleting.value) return
  deleting.value = true
  try {
    await store.deleteMistake(props.agentId, rec.recordId) // 内含 reload
    toast.success(t('k12.detail.deleted'))
    confirmDelete.value = false
    closeDetail()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
    confirmDelete.value = false
  } finally {
    deleting.value = false
  }
}

// ── 打印 / 导出（M2-3 / M3-5）──
const exportOpen = ref(false)
function todayLabel(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}
function worksheetMeta() {
  return { childName: props.agentName, title: t('k12.records.worksheetTitle'), dateLabel: todayLabel() }
}
function currentItems(): RecordItem[] {
  return view.value?.items ?? []
}
// 出卷（exportPdf 直出）旧路径已删（20260718 §3.8 改道装篮，见 buildReviewSet）；
// 下方导出仅存档案导出（错题本 PDF/Word/Markdown 档案），非出卷。
async function doExport(ext: 'pdf' | 'doc') {
  exportOpen.value = false
  const d = todayLabel().replace(/-/g, '').slice(4)
  try {
    if (ext === 'pdf') await exportPdf(currentItems(), worksheetMeta())
    else await exportWord(currentItems(), worksheetMeta(), worksheetFilename(props.agentName, t('k12.records.worksheetTitle'), d, d, 'doc'))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e)) // 导出失败 surface，不再静默无反应
  }
}
// 导出完整错题本为 Markdown（后端 GET /export 直出 md，含全部记录/状态；补齐审计 #6 未闭环）。
async function doExportMd() {
  exportOpen.value = false
  try {
    const res = await k12ExportMd(props.agentId)
    const d = todayLabel().replace(/-/g, '').slice(4)
    await download(worksheetFilename(props.agentName, t('k12.collections.mistakes'), d, d, 'md'), res.content, 'text/markdown;charset=utf-8')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="k12rec">
    <!-- 实例上下文头卡（🎓 姓名 + 年级 + 回辅导/备课卡）由外层 k12enh-tabs 唯一提供；
         此处不再自绘，避免错题本 tab 下姓名/年级重复渲染两遍（BUG-20260708 B8）。 -->

    <!-- 学习档案五对象 Tab（PRD §1.5 IA 定稿）：本周复习 / 全部错题 / 练习集 / 积累 / 作品。
         学情已提升为顶栏一等 Tab，不再是二级 Tab。 -->
    <div class="k12rec__tabs">
      <div class="seg">
        <button :class="{ on: sub === 'week' }" data-testid="subtab-week" @click="sub = 'week'">{{ t('k12.subTabs.week') }}</button>
        <button :class="{ on: sub === 'mistakes' }" data-testid="subtab-mistakes" @click="sub = 'mistakes'">{{ t('k12.subTabs.mistakes') }}</button>
        <button :class="{ on: sub === 'practiceSets' }" data-testid="subtab-practicesets" @click="sub = 'practiceSets'">{{ t('k12.subTabs.practiceSets') }}</button>
        <button :class="{ on: sub === 'accumulation' }" @click="sub = 'accumulation'">{{ t('k12.subTabs.accumulation') }}</button>
        <button :class="{ on: sub === 'works' }" data-testid="subtab-works" @click="sub = 'works'">{{ t('k12.subTabs.works') }}</button>
      </div>
      <span class="k12rec__sp" />
      <!-- 20260709 视觉评审（原型 c8a194e 定稿）：①功能位 emoji → 单色描边图标；②备份/恢复低频动作
           不占常驻顶栏 → 与导出合并进「⋯」溢出菜单（导出项仅错题 tab，备份全 tab 可达）。 -->
      <button v-if="sub === 'mistakes'" class="btn k12rec__addbtn" data-testid="mistake-add-open" @click="mistakeAddOpen = !mistakeAddOpen">
        <svg class="k12ic" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
        {{ t('k12.mistakeAdd.open') }}
      </button>
      <button v-else-if="sub === 'accumulation'" class="btn k12rec__addbtn" data-testid="accum-add-open" @click="accumAddOpen = true">
        <svg class="k12ic" viewBox="0 0 24 24"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
        {{ t('k12.accum.addOpen') }}
      </button>
      <div class="k12rec__export">
        <button class="btn" :title="t('k12.actions.more')" @click="exportOpen = !exportOpen">⋯</button>
        <div v-if="exportOpen" class="k12rec__menu">
          <template v-if="sub === 'mistakes'">
            <button @click="doExport('pdf')">{{ t('k12.actions.export') }} PDF</button>
            <button @click="doExport('doc')">{{ t('k12.actions.export') }} Word</button>
            <button @click="doExportMd">{{ t('k12.actions.export') }} Markdown</button>
          </template>
          <!-- 原型正文不放筛选条；分科过滤保留为低频溢出动作，避免挤占积累内容层级。 -->
          <template v-else-if="sub === 'accumulation'">
            <button data-testid="accum-filter-all" @click="setAccumSubject(''); exportOpen = false">{{ t('k12.accum.filterAll') }}</button>
            <button data-testid="accum-filter-chinese" @click="setAccumSubject('语文'); exportOpen = false">{{ t('k12.accum.filterChinese') }}</button>
            <button data-testid="accum-filter-english" @click="setAccumSubject('英语'); exportOpen = false">{{ t('k12.accum.filterEnglish') }}</button>
          </template>
          <button @click="exportOpen = false; emit('open-backup')">{{ t('k12.actions.backup') }}</button>
        </div>
      </div>
    </div>

    <div class="k12rec__body">
      <!-- 本周复习（行动页，PRD §3.6）：复习队列 + 趋势 + 生成复习卷；档案查管在「全部错题」。 -->
      <section v-if="sub === 'week'" data-testid="week-section">
        <div v-if="store.error" class="k12rec__err">{{ store.error }}</div>

        <!-- 项-5：复习队列空 → 正向空态卡（不留空白）。
             §3.6 本周清零庆祝态：本轮有做对清零 → 庆祝（一周唯一正反馈时刻，不做排名不做焦虑）；
             本来就无到期 → 中性计划文案。 -->
        <div v-if="view && !hasReviewQueue" class="k12empty" data-testid="review-empty-card">
          <template v-if="weekCleared">
            <div class="k12empty__icon">🎉</div>
            <b class="k12empty__title" data-testid="review-cleared-title">{{ t('k12.emptyReview.clearedTitle') }}</b>
            <p class="k12empty__sub">{{ t('k12.emptyReview.clearedSub') }}</p>
          </template>
          <template v-else>
            <div class="k12empty__icon">✅</div>
            <b class="k12empty__title">{{ t('k12.emptyReview.title') }}</b>
            <p class="k12empty__sub">{{ t('k12.emptyReview.sub') }}</p>
            <p v-if="nextReview" class="k12empty__next" data-testid="review-empty-next">
              {{ t('k12.emptyReview.nextReview', { date: nextReview.date }) }}<template v-if="nextReview.kp">（{{ nextReview.kp }}）</template>
            </p>
            <button
              v-if="view.items.length"
              class="btn k12empty__cta"
              data-testid="review-empty-cta"
              @click="practiceEarly"
            >{{ t('k12.emptyReview.practice') }}</button>
          </template>
        </div>

        <div v-if="view" class="k12mistakes">
          <RecordList :schema="MISTAKE_SCHEMA" :view="view" hide-list @action="onAction">
            <!-- 原型 c8a194e：分布括号紧贴标题 + 趋势 pill 并入行动卡（数据齐才显，诚实降级） -->
            <template #review-meta>
              <span v-if="reviewSubjectDist" class="k12dist">（{{ reviewSubjectDist }}）</span>
              <span
                v-if="trendPill"
                class="k12trend"
                :class="trendPill.up ? 'k12trend--up' : 'k12trend--flat'"
                data-testid="trend-pill"
              >{{ trendPill.label }}</span>
            </template>
            <!-- 周五留存钩子 + 查看学情入口（学情已是顶栏一等 Tab） -->
            <template #review-foot>{{ t('k12.records.weeklyHook') }} · <a class="k12rec__insightlink" data-testid="go-insights" @click="emit('go-insights')">{{ t('k12.records.viewInsights') }} ›</a></template>
            <template #review-actions>
              <!-- §3.8 购物车模型：生成复习卷 = 本周待复习批量装篮（幂等），打印/发送在练习集完成 -->
              <button class="btn btn-primary" data-testid="build-review-set" :disabled="basketBusy" @click="buildReviewSet">
                <svg class="k12ic" viewBox="0 0 24 24"><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v8H6z" /></svg>
                {{ t('k12.records.genWorksheet') }}
              </button>
              <button class="btn" data-testid="custom-paper-open" @click="customPaperOpen = !customPaperOpen">
                <svg class="k12ic" viewBox="0 0 24 24"><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M2 14h4" /><path d="M10 8h4" /><path d="M18 16h4" /></svg>
                {{ t('k12.records.customPaper') }}
              </button>
            </template>
          </RecordList>
        </div>
      </section>

      <!-- 全部错题（档案页，PRD §3.7）：查找、核对、管理——直接展开筛选 + 全量，不与本周复习重复行动。 -->
      <section v-else-if="sub === 'mistakes'" data-testid="mistakes-section">
        <div v-if="store.error" class="k12rec__err">{{ store.error }}</div>
        <p class="k12rec__hint" style="margin-top: 0">{{ t('k12.records.archiveDesc') }}</p>
        <div v-if="view" class="k12mistakes">
          <RecordList :schema="MISTAKE_SCHEMA" :view="view" hide-review @action="onAction" />
        </div>
        <!-- 归档规则脚注（原型 1599） -->
        <p v-if="view" class="k12rec__hint">{{ t('k12.records.stateMachineHint') }}</p>
      </section>

      <!-- 练习集：组好的题（真实 /practice-sets）——生命周期 + 发布门 -->
      <section v-else-if="sub === 'practiceSets'" data-testid="practicesets-section">
        <K12PracticeSetsPanel :agent-id="props.agentId" />
      </section>

      <!-- 积累本：语/英沉淀（真实 /accumulation）——记录本原语第二场景 -->
      <section v-else-if="sub === 'accumulation'" class="k12accum" data-testid="accum-prototype">
        <!-- 原型 rc1（app.html:1618）：积累 tab 带 cxsec 标题 + 说明（错题 tab 无标题——顶栏已声明身份；
             积累 / 学情 tab 各有 h2 标题，与学情 tab reporthead 同款）。 -->
        <div class="k12rec__reporthead">
          <h3 class="k12rec__h" style="margin: 0">{{ t('k12.accum.title') }}</h3>
          <span class="k12rec__hint" style="margin: 0">{{ t('k12.accum.desc') }}</span>
        </div>
        <!-- 原型 app.html:1619-1623：积累不是错题状态机，固定单行“学科→内容→类型→出处→状态→详情”。 -->
        <div v-if="accumView && accumView.items.length" class="k12accum__list">
          <!-- 20260718 原型定案对齐（引文列表）：引文置首整行（衬线 + 引号压角，量度 62ch），
               meta 行 = 学科/类型/来源/收藏日期/状态/详情；结构同 .k12accum__row 换皮。 -->
          <div v-for="item in accumView.items" :key="item.recordId" class="k12accum__row k12accum__row--quote">
            <b class="k12accum__title" :title="accumField(item, 'content')">{{ accumField(item, 'content') }}</b>
            <span class="k12accum__subject">{{ accumField(item, 'subject') }}</span>
            <span class="k12accum__type">{{ accumField(item, 'entry_type') }}</span>
            <span class="k12accum__source" :title="accumSourceLabel(item)">{{ accumSourceLabel(item) }}</span>
            <span v-if="accumDate(item)" class="k12accum__date" data-testid="accum-date">{{ accumDate(item) }}</span>
            <span class="k12accum__status" :class="`k12accum__status--${accumStatusTone(item)}`">{{ accumStatusLabel(item) }}</span>
            <button class="btn btn-ghost k12accum__detail" @click="openDetail(item, 'accum')">{{ t('records.detail') }}</button>
          </div>
        </div>
        <!-- 积累空态：对齐原型 rc1——原型积累区无「大居中卡」形态，只是列表区；空时给克制的
             列表占位一行（记录入口常驻在上方 .k12accum__bar 的「＋记到积累本」，不再叠一个大 CTA 卡）。 -->
        <p v-else class="k12accum__empty" data-testid="accum-empty-card">
          {{ t('k12.emptyAccum.title') }} · {{ t('k12.emptyAccum.sub') }}
        </p>
        <!-- 分界规则脚注（原型 rc1 · 2026-07-08 口径）：错了要改→错题 / 好东西要记住→积累 -->
        <p class="k12rec__hint">{{ t('k12.records.dividerRule') }}</p>
      </section>

      <!-- 作品：语文写作 / 美术（真实 /creative-works）——成长版本 + 证据化点评 -->
      <section v-else-if="sub === 'works'" data-testid="works-section">
        <K12CreativeWorksPanel :agent-id="props.agentId" />
      </section>

      <!-- 学情已提升为顶栏一等 Tab（K12InsightPanel，2026-07-18 IA 迁移），不再是二级 Tab。 -->
    </div>

    <!-- 记一条错题 modal（原型 c8a194e openAddMistake=弹窗，非内联手风琴 · BUG-20260709）
         手工录入：课堂/学校/线下没经过 App 的错题也能进本子。走 store.grade 同一验算管道。 -->
    <div v-if="mistakeAddOpen" class="k12modal" @click.self="mistakeAddOpen = false">
      <div class="k12modal__card">
        <div class="k12modal__head">
          <b>{{ t('k12.mistakeAdd.open') }}</b>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="mistakeAddOpen = false">✕</button>
        </div>
        <!-- 20260718 原型布局定案对齐：规则提示降到表单底部，不挡英雄字段 -->
        <div class="k12accum__form k12accum__form--modal" data-testid="mistake-add-form">
          <!-- 20260712 视觉评审定案（原型 openAddMistake 同步）：题目=英雄字段置首、多行 textarea
               （应用题/古诗/英语整句整段粘贴，单行 input=捕获时刻流失条目）；错处同多行；
               textarea 内 Enter=换行，⌘/Ctrl+Enter 提交。实现不得回退单行 input。 -->
          <textarea
            v-model="mistakeForm.problem"
            class="k12accum__content k12accum__content--area"
            data-testid="mistake-problem"
            rows="3"
            :placeholder="t('k12.mistakeAdd.problemPh')"
            @keydown="onMistakeKeydown"
          />
          <div class="k12accum__field" data-testid="mistake-subject">
            <span>{{ t('k12.accum.subject') }}</span>
            <HcSelect
              v-model="mistakeForm.subject"
              :options="mistakeSubjectOptions"
              :placeholder="t('k12.prep.pickHint')"
            />
          </div>
          <textarea
            v-model="mistakeForm.studentAnswer"
            class="k12accum__content k12accum__content--area"
            data-testid="mistake-answer"
            rows="2"
            :placeholder="t('k12.mistakeAdd.answerPh')"
            @keydown="onMistakeKeydown"
          />
          <input
            v-model="mistakeForm.knowledgePoints"
            class="k12accum__content"
            :placeholder="t('k12.mistakeAdd.kpPh')"
          />
          <div class="k12rec__addhint">{{ t('k12.mistakeAdd.hint') }}</div>
          <div class="k12accum__actions">
            <button class="btn btn-ghost" @click="mistakeAddOpen = false">{{ t('k12.accum.cancel') }}</button>
            <button
              class="btn btn-primary"
              data-testid="mistake-submit"
              :disabled="!mistakeForm.subject || !mistakeForm.problem.trim() || mistakeSaving"
              @click="submitMistake"
            >{{ mistakeSaving ? t('k12.mistakeAdd.submitting') : t('k12.mistakeAdd.submit') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 积累本手动记录：与「记一条错题」一致，使用模态表单，避免挤压列表。 -->
    <div
      v-if="accumAddOpen"
      class="k12modal"
      data-testid="accum-add-form"
      @click.self="accumAddOpen = false"
    >
      <div class="k12modal__card">
        <div class="k12modal__head">
          <b>{{ t('k12.accum.addOpen') }}</b>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="accumAddOpen = false">✕</button>
        </div>
        <!-- 20260718 原型布局定案对齐：内容=英雄字段置首（同「记一条错题」题目置首惯例），科目+类型并排次之 -->
        <div class="k12accum__form k12accum__form--modal">
          <textarea
            v-model="accumForm.content"
            class="k12accum__content"
            data-testid="accum-add-content"
            :placeholder="t('k12.accum.contentPlaceholder')"
            rows="4"
          />
          <div class="k12accum__row">
            <div class="k12accum__field" data-testid="accum-add-subject">
              <span>{{ t('k12.accum.subject') }}</span>
              <HcSelect v-model="accumForm.subject" :options="accumSubjectOptions" />
            </div>
            <div class="k12accum__field" data-testid="accum-add-type">
              <span>{{ t('k12.accum.type') }}</span>
              <HcSelect v-model="accumForm.entry_type" :options="accumTypeOptions" />
            </div>
          </div>
          <div class="k12accum__actions">
            <button class="btn btn-ghost" @click="accumAddOpen = false">{{ t('k12.accum.cancel') }}</button>
            <button
              class="btn btn-primary"
              data-testid="accum-add-submit"
              :disabled="!accumForm.content.trim() || accumSaving"
              @click="submitAccum"
            >{{ t('k12.accum.submit') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 自定义组卷 modal（原型 openCustomPaper=弹窗，同构位置 · BUG-20260709）
         渐进披露：一键零配置仍是主动作，微调参数走此弹窗。 -->
    <div v-if="customPaperOpen" class="k12modal" @click.self="customPaperOpen = false">
      <div class="k12modal__card">
        <div class="k12modal__head">
          <b>{{ t('k12.records.customPaper') }}</b>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="customPaperOpen = false">✕</button>
        </div>
        <div class="k12accum__form k12accum__form--modal" data-testid="custom-paper-form">
          <div class="k12rec__addhint">{{ t('k12.customPaper.hint') }}</div>
          <!-- 范围（原型 openCustomPaper 四档，UI 先做两档：本周待复习 / 全部未掌握） -->
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.scope') }}</span>
            <button
              v-for="o in paperScopeOpts" :key="o.v"
              class="chip" :class="{ on: paperForm.scope === o.v }"
              :data-testid="`paper-scope-${o.v}`"
              @click="paperForm.scope = o.v"
            >{{ o.label }}</button>
          </div>
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.perQ') }}</span>
            <button
              v-for="n in paperPerQOpts" :key="n"
              class="chip" :class="{ on: paperForm.perQ === n }"
              @click="paperForm.perQ = n"
            >{{ n }}</button>
          </div>
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.difficulty') }}</span>
            <button
              v-for="o in paperDiffOpts" :key="o.v"
              class="chip" :class="{ on: paperForm.difficulty === o.v }"
              @click="paperForm.difficulty = o.v"
            >{{ o.label }}</button>
          </div>
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.total') }}</span>
            <button
              v-for="o in paperTotalOpts" :key="o.v"
              class="chip" :class="{ on: paperForm.total === o.v }"
              @click="paperForm.total = o.v"
            >{{ o.label }}</button>
          </div>
          <div class="k12accum__actions">
            <button class="btn btn-ghost" @click="customPaperOpen = false">{{ t('k12.accum.cancel') }}</button>
            <button class="btn btn-primary" data-testid="custom-paper-gen" @click="genCustomPaper">{{ t('k12.customPaper.generate') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 「再练一道」变式题结果弹层 -->
    <div v-if="retry.open" class="k12retry" @click.self="closeRetry">
      <div class="k12retry__card">
        <div class="k12retry__head">
          <!-- UX-2：再练是练习变式题、不是批改——不显验算徽章（badge/verdict），只题目 + 解答，
               免家长把 unverifiable 误读成「验证失败」。验算徽章只用于「批改」结果。 -->
          <b>{{ t('k12.records.retryTitle') }}</b>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="closeRetry">✕</button>
        </div>
        <p v-if="retry.loading" class="k12rec__hint" data-testid="retry-loading">{{ t('k12.records.retryLoading') }}</p>
        <div v-else-if="retry.error" class="k12retry__err" data-testid="retry-error">
          <p class="k12rec__hint">{{ t('k12.records.retryFailed') }}</p>
          <button
            class="btn btn-primary"
            data-testid="retry-again"
            @click="retryRecord && doRetry(retryRecord)"
          >{{ t('k12.records.retryRetryBtn') }}</button>
        </div>
        <template v-else>
          <!-- 题答分离（P2 清偿）：题面先显（孩子可直接做题），只遮解答；拆不出时整段遮罩回退 -->
          <MarkdownRenderer
            v-if="retry.question"
            class="k12retry__body k12retry__question"
            data-testid="retry-question"
            :content="retry.question"
          />
          <p class="k12retry__mask">🔒 {{ t('k12.records.retryMaskHint') }}</p>
          <!-- 守答案真遮罩：未揭示时模糊 + 禁选中（防孩子凑近一眼看光），家长点按才显示 -->
          <div class="k12retry__bodywrap" :class="{ 'k12retry__bodywrap--masked': !retry.revealed }">
            <!-- 变式题为模型生成的富文本（**加粗** / 列表 / LaTeX 数学）→ md 渲染，勿裸显 markdown 标记。
                 遮罩层与 aria-hidden 保留：未揭示时模糊 + 不可读屏。 -->
            <MarkdownRenderer class="k12retry__body" :aria-hidden="!retry.revealed" :content="retry.question ? retry.answer : retry.solution" />
            <button
              v-if="!retry.revealed"
              class="btn btn-primary k12retry__reveal"
              data-testid="retry-reveal"
              @click="retry.revealed = true"
            >{{ t('k12.records.retryReveal') }}</button>
          </div>
          <div v-if="retry.revealed" class="k12retry__actions">
            <!-- 装篮入口（§3.8 入口1）：变式题加入待打印篮，打印时随卷固化 -->
            <button
              class="btn btn-primary"
              :disabled="retry.basketed"
              data-testid="retry-add-basket"
              @click="addRetryToBasket"
            >{{ retry.basketed ? t('k12.records.basketAddedBtn') : t('k12.records.addToBasket') }}</button>
            <button class="btn" data-testid="retry-copy" @click="copyRetrySolution">
              <svg class="k12ic" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              {{ t('k12.records.retryCopy') }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- 错题详情弹层（BUG-20260712-#2）：复用列表已有 RecordItem 字段，不额外请求后端，可关闭。 -->
    <div v-if="detail.open && detail.record" class="k12modal" data-testid="mistake-detail" @click.self="closeDetail">
      <div class="k12modal__card">
        <div class="k12modal__head">
          <b>{{ t('k12.detail.title') }}</b>
          <span
            v-if="detailStatus"
            class="k12detail__status" :class="`k12detail__status--${detailStatusTone}`"
            data-testid="detail-status"
          >{{ detailStatus }}</span>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="closeDetail">✕</button>
        </div>
        <!-- 积累本详情：内容 / 学科 / 类型（积累不复习，无错因/再练语义） -->
        <div v-if="detail.kind === 'accum'" class="k12detail">
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.content') }}</span>
            <MarkdownRenderer class="k12detail__val k12detail__val--md" data-testid="detail-content" :content="detailContent || '—'" />
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.accum.subject') }}</span>
            <p class="k12detail__val" data-testid="detail-accum-subject">{{ detailAccumSubject || '—' }}</p>
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.accum.type') }}</span>
            <p class="k12detail__val" data-testid="detail-accum-type">{{ detailAccumType || '—' }}</p>
          </div>
          <!-- §3.9 检验出口：生成默写题加入练习集（打印回传才进自动复批闭环） -->
          <div class="k12detail__actions">
            <button
              class="btn"
              data-testid="accum-dictation-to-basket"
              :disabled="dictationBusy || dictationAdded.includes(detail.record!.recordId)"
              @click="dictationToBasket"
            >{{ dictationAdded.includes(detail.record!.recordId) ? t('k12.accum.dictationAdded') : t('k12.accum.dictationToBasket') }}</button>
          </div>
          <p class="k12rec__hint" style="margin-top: 4px">{{ t('k12.accum.dictationHint') }}</p>
        </div>
        <!-- 错题详情：题目 / 知识点 / 错因 -->
        <div v-else class="k12detail">
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.question') }}</span>
            <MarkdownRenderer class="k12detail__val k12detail__val--md" data-testid="detail-question" :content="detailQuestion || '—'" />
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.knowledgePoint') }}</span>
            <p class="k12detail__val" data-testid="detail-kp">{{ detailKp || '—' }}</p>
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.errorCause') }}</span>
            <MarkdownRenderer class="k12detail__val k12detail__val--md" data-testid="detail-error" :content="detailError || t('k12.detail.noErrorCause')" />
          </div>
          <!-- 抽查复验未过（§3.6 规则 3/4）：事实标注 + 温和话术，不否定家长判断，只补齐证据 -->
          <p v-if="detailSpotCheckFailed" class="k12detail__spotcheck" data-testid="detail-spotcheck-failed">
            {{ t('k12.detail.spotCheckFailed') }} · {{ t('k12.detail.spotCheckFailedHint') }}
          </p>
        </div>
        <p v-if="detail.kind !== 'accum'" class="k12rec__hint">{{ t('k12.detail.footnote') }}</p>
        <!-- UX-1：详情弹层「家长确认已会」（已掌握态改显只读徽标，幂等）。仅错题（积累不复习/无掌握语义）。 -->
        <div v-if="detail.kind !== 'accum'" class="k12detail__actions">
          <button
            v-if="!detailMastered"
            class="btn btn-primary"
            data-testid="detail-mark-mastered"
            @click="markMasteredFromDetail"
          >{{ t('records.markMastered') }}</button>
          <span
            v-else
            class="k12detail__status k12detail__status--got"
            data-testid="detail-mastered-label"
          >{{ t('k12.detail.alreadyMastered') }}</span>
          <span class="k12rec__sp" />
          <!-- UX-3：克制删除入口——ghost 次级样式（非首屏主按钮），二次确认后才删。 -->
          <button
            class="btn btn-ghost k12detail__del"
            data-testid="detail-delete"
            @click="askDelete"
          >{{ t('k12.detail.delete') }}</button>
        </div>
        <p v-if="detail.kind !== 'accum'" class="k12detail__delhint">{{ t('k12.detail.deleteHint') }}</p>
      </div>
    </div>

    <!-- UX-3：删除二次确认（复用平台 ConfirmDialog；副文案说明用途=移除记错/重复条目）。 -->
    <ConfirmDialog
      :open="confirmDelete"
      :title="t('k12.detail.deleteConfirmTitle')"
      :message="t('k12.detail.deleteConfirmMsg')"
      :confirm-text="t('k12.detail.deleteConfirmOk')"
      :cancel-text="t('k12.accum.cancel')"
      :danger="true"
      @confirm="doDelete"
      @cancel="confirmDelete = false"
    />
  </div>
</template>

<style scoped>
.k12rec { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.k12rec__tabs {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 0.5px solid var(--hc-border);
}
.k12rec__sp { flex: 1; }
.k12rec__body { flex: 1; overflow: auto; padding: 16px 20px 40px; }
.k12rec__err { color: var(--hc-error); font-size: 13px; margin-bottom: 10px; }
.k12rec__export { position: relative; }
.k12rec__menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 20;
  background: var(--hc-bg-elevated); border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md); box-shadow: var(--hc-shadow-md); padding: 4px; min-width: 120px;
  display: flex; flex-direction: column;
}
.k12rec__menu button {
  text-align: left; padding: 7px 10px; border: none; background: transparent;
  color: var(--hc-text-primary); font-size: 13px; border-radius: var(--hc-radius-sm); cursor: pointer;
  white-space: nowrap; /* BUG-20260710 ②：「导出 Markdown」曾折成两行 */
}
.k12rec__menu button:hover { background: var(--hc-bg-hover); }
.k12rec__hint { font-size: 11.5px; color: var(--hc-text-muted); margin-top: 12px; }
.k12rec__insightlink { color: var(--hc-accent); cursor: pointer; }
.k12rec__insightlink:hover { text-decoration: underline; }
.k12rec__alert {
  margin-top: 14px; padding: 10px 12px; border-radius: var(--hc-radius-md);
  border-left: 3px solid var(--hc-warning); background: color-mix(in srgb, var(--hc-warning) 8%, transparent);
  font-size: 12.5px; color: var(--hc-text-secondary);
}
.k12rec__sugg {
  margin-top: 10px; padding: 10px 12px; border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border);
  font-size: 12.5px; color: var(--hc-text-secondary);
}
.k12rec__h { font-size: 13px; font-weight: 600; margin: 18px 0 4px; }
.k12rec__reporthead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.k12rec__tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; } /* M1：原型 mini-grid 4 块 */
.k12tile {
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md); padding: 12px 14px; font-size: 12px; color: var(--hc-text-secondary);
  display: flex; flex-direction: column; gap: 2px;
}
.k12tile b { font-size: 18px; color: var(--hc-text-primary); }
.k12bars { max-width: 520px; margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.k12bar { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.k12bar__label { width: 100px; flex-shrink: 0; color: var(--hc-text-secondary); }
.k12bar__rail { flex: 1; height: 9px; background: var(--hc-bg-input); border-radius: 99px; overflow: hidden; }
.k12bar__fill { display: block; height: 100%; background: var(--hc-accent); border-radius: 99px; }
.k12bar b { width: 26px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; }
/* 积累本分科过滤 + 手动记录 */
.k12accum__list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.k12accum__row {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 9px 10px;
  border: 0.5px solid var(--hc-border); border-radius: 10px; background: var(--hc-bg-card);
  color: var(--hc-text-secondary); font-size: 12px;
}
.k12accum__subject {
  flex: none; padding: 1px 7px; border-radius: 6px; font-size: 11px;
  background: var(--hc-bg-active); color: var(--hc-text-secondary);
}
.k12accum__title {
  flex: 0 1 auto; min-width: 0; max-width: 46%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--hc-text-primary);
}
.k12accum__type {
  flex: none; padding: 2px 7px; border-radius: 4px; white-space: nowrap;
  background: var(--hc-accent-subtle); color: var(--hc-accent); font-size: 10.5px; font-weight: 650;
}
.k12accum__source { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k12accum__status { flex: none; padding: 2px 9px; border-radius: 999px; font-size: 10.5px; font-weight: 700; white-space: nowrap; }
.k12accum__status--na { color: var(--hc-text-muted); background: var(--hc-bg-input); }
.k12accum__status--got { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.k12accum__detail { flex: none; }
/* 20260718 原型定案（引文列表）：引文衬线置首 + 引号压角，量度 62ch；meta 行随 flex-wrap 落第二行 */
.k12accum__row--quote { flex-wrap: wrap; align-content: flex-start; row-gap: 8px; padding: 14px 16px 12px; border-radius: 16px; box-shadow: var(--hc-shadow-sm); }
.k12accum__row--quote .k12accum__title {
  flex: 1 1 100%; max-width: 62ch; order: -1; white-space: normal; overflow: visible;
  font-family: 'Songti SC', ui-serif, STSong, serif; font-size: 14.5px; line-height: 1.65;
  font-weight: 600; position: relative; padding-left: 26px;
}
.k12accum__row--quote .k12accum__title::before {
  content: '\201C'; position: absolute; left: 0; top: -4px; font-size: 27px; line-height: 1;
  font-family: Georgia, ui-serif, serif; color: var(--hc-accent); opacity: 0.55;
}
.k12accum__date { flex: none; font-variant-numeric: tabular-nums; color: var(--hc-text-muted); font-size: 12px; }
.chip {
  font-size: 12px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-secondary);
}
.chip.on { background: var(--hc-accent-subtle); color: var(--hc-accent); border-color: var(--hc-border-hl); font-weight: 600; }
.k12accum__form {
  display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; padding: 12px;
  border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md); background: var(--hc-bg-elevated);
}
.k12accum__row { display: flex; gap: 14px; flex-wrap: wrap; }
.k12accum__field { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--hc-text-secondary); min-width: 130px; flex: 1; }
.k12accum__field > span { font-size: 12.5px; }
.k12accum__content {
  width: 100%; box-sizing: border-box; font-size: 13px; padding: 8px 10px; resize: vertical;
  border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-primary);
}
/* 多行捕获字段（20260712：题目/错处适配长内容——应用题/古诗/整句整段粘贴） */
.k12accum__content--area {
  font: inherit; font-size: 13px; line-height: 1.5; min-height: 44px; resize: vertical;
}
.k12accum__actions { display: flex; justify-content: flex-end; gap: 8px; }
/* 积累空态：克制列表占位（原型 rc1 无大居中卡；入口在上方 bar 常驻） */
.k12accum__empty { color: var(--hc-text-muted); font-size: 13px; padding: 22px 4px; text-align: center; margin: 0; }
/* modal 内的表单去掉自带卡片边框（弹层卡片已提供容器） */
.k12accum__form--modal { border: none; background: transparent; padding: 0; margin-bottom: 0; }
/* 记一条错题 / 自定义组卷 弹窗（原型 modal 形态；与 .k12retry 同族样式） */
.k12modal { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.32); padding: 24px; }
.k12modal__card { width: min(520px, 100%); max-height: 80vh; overflow: auto; background: var(--hc-bg-elevated); border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-lg); box-shadow: var(--hc-shadow-lg); padding: 16px 18px; }
.k12modal__head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; font-size: 13.5px; }
/* 手工录入错题 / 自定义组卷 */
.k12rec__addhint { font-size: 11.5px; color: var(--hc-text-muted); line-height: 1.5; }
.k12paper__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.k12paper__label { font-size: 12.5px; color: var(--hc-text-secondary); width: 92px; flex-shrink: 0; }
/* seg / pill / btn 复用全局 global.css 令牌类 */
.seg { position: relative; display: inline-flex; background: var(--hc-bg-input); border: 1px solid var(--hc-border); border-radius: 11px; padding: 3px; gap: 2px; }
.seg button { padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 500; color: var(--hc-text-muted); background: transparent; border: none; cursor: pointer; }
.seg button.on { background: var(--hc-bg-elevated); color: var(--hc-accent); box-shadow: var(--hc-shadow-sm); font-weight: 600; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px; border-radius: 7px; }
.pill-green { background: rgba(50, 213, 131, 0.14); color: var(--hc-success); }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary); }
.btn:hover { background: var(--hc-bg-hover); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--hc-text-secondary); }
.btn-primary { background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent; }
/* BUG-20260709：必须配对 hover——否则 .btn:hover(0,2,0) 压过 .btn-primary(0,1,0) 的渐变，
   浅色主题下 hover = 近白底 + color:#fff 白字看不见。渐变对齐原型 app.html:158（更亮一档）。 */
.btn-primary:hover { background: linear-gradient(180deg, #67b8ec 0%, #4f9fe1 100%); }
/* 功能位单色描边图标（20260709 视觉评审：emoji 只留身份/语义徽章位；与原型 .ic-sm 同规格） */
.k12ic { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
.k12rec__addbtn { display: inline-flex; align-items: center; gap: 5px; }
/* 全部错题=默认折叠的次级档案（原型 1598 <details>）：折叠态隐藏筛选 + 档案行（.record-list 直接子 .rl-rows），
   「本周复习」的 .rl-review .rl-rows 是嵌套子、不受 > 直接子选择器命中，故行动卡常驻。 */
.k12arch__toggle {
  display: inline-flex; align-items: center; gap: 6px; padding: 0; border: none; background: none;
  font-size: 13px; font-weight: 700; color: var(--hc-text-primary); cursor: pointer;
}
.k12arch__caret { font-size: 10px; color: var(--hc-text-muted); transition: transform 0.15s ease; }
.k12arch__caret--open { transform: rotate(90deg); }
.k12mistakes--collapsed :deep(.rl-filters),
.k12mistakes--collapsed :deep(.rl-empty),
.k12mistakes--collapsed :deep(.record-list > .rl-rows) { display: none; }
/* 「本周复习」行动卡：跨科分布 + 趋势 pill（原型 stpill got/done 同源色） */
.k12dist { font-size: 12.5px; color: var(--hc-text-secondary); margin-left: -4px; }
.k12trend {
  font-size: 10.5px; border-radius: 999px; padding: 2px 9px; font-weight: 700; white-space: nowrap;
}
.k12trend--up { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.k12trend--flat { color: var(--hc-warning); background: color-mix(in srgb, var(--hc-warning) 12%, transparent); }
/* 学科定色（原型 .kpill.chi/.eng 同源）：错题列表最高频扫读维度=哪科错得多。
   RecordList 保持领域无关，经 data-chip 前缀选择器由本场景层上色（chip 文案「学科·知识点」）。 */
:deep(.rl-chip[data-chip^='语文']) { background: color-mix(in srgb, #e8590c 12%, transparent); color: #e8590c; }
:deep(.rl-chip[data-chip^='英语']) { background: color-mix(in srgb, #7048e8 10%, transparent); color: #7048e8; }
/* 再练一道弹层 */
.k12retry { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.32); padding: 24px; }
.k12retry__card { width: min(560px, 100%); max-height: 80vh; overflow: auto; background: var(--hc-bg-elevated); border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-lg); box-shadow: var(--hc-shadow-lg); padding: 16px 18px; }
.k12retry__head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.k12retry__mask { font-size: 11.5px; color: var(--hc-warning); margin-bottom: 8px; }
/* 题面区（题答分离）：先显不遮罩，与遮罩解答区视觉分隔 */
.k12retry__question { padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dashed var(--hc-border); }
/* md 渲染:块级元素自带间距，勿用 pre-wrap（会多出空白）。保留字号/断词/色，遮罩 blur 作用于本容器。 */
.k12retry__body {
  word-break: break-word; font-size: 13px; line-height: 1.6; color: var(--hc-text-primary); margin: 0;
  padding: 16px 20px; border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
}
/* 守答案真遮罩：模糊 + 禁选中；揭示按钮悬浮居中 */
.k12retry__bodywrap { position: relative; }
.k12retry__bodywrap--masked .k12retry__body { filter: blur(7px); user-select: none; pointer-events: none; }
.k12retry__reveal { position: absolute; inset: 0; margin: auto; width: fit-content; height: fit-content; }
.k12retry__actions { display: flex; justify-content: flex-end; margin-top: 10px; }
/* 再练失败态：可重试提示（不静默关弹层 · BUG-20260712-#1） */
.k12retry__err { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
/* 错题详情弹层（BUG-20260712-#2）：字段行 label + 值 */
.k12detail { display: flex; flex-direction: column; gap: 12px; margin: 4px 0 6px; }
.k12detail__row { display: flex; flex-direction: column; gap: 3px; }
.k12detail__label { font-size: 11.5px; color: var(--hc-text-muted); }
.k12detail__val { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--hc-text-primary); white-space: pre-wrap; word-break: break-word; }
/* md 渲染变体:块级元素自带间距，取消 pre-wrap 避免多余空白（纯文本字段仍用基类的 pre-wrap）。 */
.k12detail__val--md { white-space: normal; }
.k12detail__status { font-size: 10.5px; border-radius: 999px; padding: 2px 9px; font-weight: 700; white-space: nowrap; }
.k12detail__status--todo { color: var(--hc-error); background: color-mix(in srgb, var(--hc-error) 10%, transparent); }
.k12detail__status--done { color: var(--hc-warning); background: color-mix(in srgb, var(--hc-warning) 12%, transparent); }
.k12detail__status--got { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.k12detail__status--na { color: var(--hc-text-muted); background: var(--hc-bg-input); }
.k12detail__spotcheck {
  margin: 4px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 8%, transparent);
  border-radius: var(--hc-radius-md); padding: 7px 10px;
}
/* UX-1/3：详情弹层动作行（家长确认已会 = 主动作左；删除 = 克制 ghost，右侧，弱化） */
.k12detail__actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.k12detail__del { color: var(--hc-error); }
.k12detail__del:hover { background: color-mix(in srgb, var(--hc-error) 10%, transparent); }
.k12detail__delhint { font-size: 11px; color: var(--hc-text-muted); margin-top: 6px; }
/* 项-5：正向空态卡（与「本周复习」行动卡等视觉重量，填住空白，不留悬空） */
.k12empty {
  display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px;
  padding: 26px 18px; border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border);
}
.k12empty__icon { font-size: 30px; line-height: 1; margin-bottom: 2px; }
.k12empty__title { font-size: 14.5px; color: var(--hc-text-primary); }
.k12empty__sub { font-size: 12.5px; color: var(--hc-text-secondary); margin: 0; }
.k12empty__next { font-size: 12px; color: var(--hc-text-muted); margin: 2px 0 0; font-variant-numeric: tabular-nums; }
.k12empty__cta { margin-top: 10px; }
</style>
