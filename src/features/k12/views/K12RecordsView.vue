<script setup lang="ts">
/**
 * K12 错题本 / 积累本 / 学情（features/k12）· M1-6 记录视图 + M3-6 复习引擎 + M3-7 学情报告。
 *
 * 复用通用 shell 的 RecordList（schema 驱动），本组件只提供 K12 数据接线 + 场景专属动作
 * （出错题卷 / 导出 / 备份）+ 学情聚合。多孩隔离 = 以 agentId 拉取，切实例即换数据。
 */
import { computed, nextTick, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import RecordList from '@/shell/records/RecordList.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useToast } from '@/composables/useToast'
import { setClipboard } from '@/api/desktop'
import { useK12Store } from '../store'
import { useAgentsStore } from '@/stores/agents'
import K12PracticeSetsPanel from './K12PracticeSetsPanel.vue'
import K12CreativeWorksPanel from './K12CreativeWorksPanel.vue'
import K12ProfileForm from './K12ProfileForm.vue'
import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'
import K12PersistentPrintController from '../components/K12PersistentPrintController.vue'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'
import {
  k12ExportMd,
  k12AddAccumulation,
  k12DeleteAccumulation,
  k12GenerateAccumulationDictation,
  k12GenerateCustomPaper,
  k12GetCurriculumProgress,
  k12GetPrintArtifactContent,
  k12GetWeeklyPracticeHistory,
  k12GetWeeklyPracticeSettings,
  k12EnsureWeeklyPracticePlan,
  k12PrepareWeeklyPracticeOutput,
  k12SaveWeeklyPracticePlanToPracticeSet,
  k12SendWeeklyPracticeSnapshot,
  k12GetMistakePracticeGeneration,
  k12ListPracticeSets,
  k12ListCreativeWorks,
  k12RetryMistakePracticeGeneration,
  k12SendAccumulation,
  k12StartMistakePracticeGeneration,
  type AccumulationDictationGenerationDTO,
  type AccumulationDictationStatus,
  type CustomPaperDifficulty,
  type CustomPaperResp,
  type CustomPaperScope,
  type CustomPaperTotal,
  type MistakePracticeGenerationDTO,
  type CurriculumProgressDTO,
  type WeeklyPracticeHistorySummaryDTO,
  type WeeklyPracticePlanDTO,
  type WeeklyPracticePrepareOutputResp,
  type WeeklyPracticeSettingsDTO,
} from '@/api/k12'
import { useK12DeliveryBatch } from '../useK12DeliveryBatch'
import { MISTAKE_SCHEMA } from '../schemas'
import { exportArchiveDocument, worksheetFilename, download, savePdfArtifact } from '../export'
import type { RecordCollectionView, RecordItem } from '@/contracts'
import type {
  K12MistakeStatusFilter,
  K12RecordsNavigation,
  K12RecordsTarget,
} from '../records-navigation'
import type { ScenarioTextModelRoute } from '@/shell/scenario/registry'

const props = defineProps<{
  agentId: string
  agentName: string
  grade: string
  /** 教材边界（k12.textbook_edition）；旧直挂测试可从「年级 · 教材」兼容解析。 */
  textbook?: string
  /** 当前场景文本任务的冻结路由；缺省时由服务端解析默认模型。 */
  modelRoute?: ScenarioTextModelRoute
  /** v-show 保活时的可见态；从辅导切回档案必须刷新，避免展示进入会话时的旧缓存。 */
  active?: boolean
  /** 学情路由器直达目标；变化时切到对应档案对象。 */
  target?: K12RecordsTarget
  /** 场景动作直达全部错题时可同步选中学科；空值清除该直达过滤。 */
  subject?: string
  /** 学情直达的错题状态；all 显式清除该维筛选。 */
  status?: K12MistakeStatusFilter
  /** 完整的下钻命令；对象身份变化时重放三维，包括与上次值相同的重复下钻。 */
  navigation?: K12RecordsNavigation
}>()

const emit = defineEmits<{
  (e: 'go-tutor'): void
  (e: 'go-insights'): void
  (e: 'open-backup'): void
}>()

const { t } = useI18n()
const toast = useToast()
const store = useK12Store()
const agentsStore = useAgentsStore()
const accumulationDelivery = useK12DeliveryBatch({
  agent: () => props.agentId,
  idleLabel: '发送到手机',
})
const weeklyDelivery = useK12DeliveryBatch({
  agent: () => props.agentId,
  idleLabel: '发送到手机',
})
const weeklyProgress = ref<CurriculumProgressDTO | null>(null)
const weeklySettings = ref<WeeklyPracticeSettingsDTO | null>(null)
const weeklyPlan = ref<WeeklyPracticePlanDTO | null>(null)
const weeklyHistory = ref<WeeklyPracticeHistorySummaryDTO[]>([])
const weeklyOutput = ref<WeeklyPracticePrepareOutputResp | null>(null)
const weeklyLoading = ref(true)
const weeklyBusy = ref(false)
const weeklyError = ref('')
const weeklyPrintController = ref<InstanceType<typeof K12PersistentPrintController>>()
const profileOpen = ref(false)
const profileAgent = computed(() =>
  agentsStore.agents.find((agent) => agent.name === props.agentId),
)

function weeklyCommandKey(kind: string, identity: string): string {
  return `desktop-weekly-${kind}:${props.agentId}:${identity}`
}

const weeklyPlanIntent = ref<{ agent: string; commandKey: string } | null>(null)
let weeklyPlanKeySequence = 0

function weeklyPlanCommandKey(): string {
  if (weeklyPlanIntent.value?.agent === props.agentId) {
    return weeklyPlanIntent.value.commandKey
  }
  const identity =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++weeklyPlanKeySequence}`
  const commandKey = weeklyCommandKey('plan', identity)
  weeklyPlanIntent.value = { agent: props.agentId, commandKey }
  return commandKey
}

async function loadWeeklyPractice() {
  if (!props.agentId) return
  weeklyLoading.value = true
  weeklyError.value = ''
  try {
    const [progressResp, settingsResp, planResp, historyResp] = await Promise.all([
      k12GetCurriculumProgress(props.agentId),
      k12GetWeeklyPracticeSettings(props.agentId),
      k12EnsureWeeklyPracticePlan(props.agentId, weeklyPlanCommandKey()),
      k12GetWeeklyPracticeHistory(props.agentId, undefined, 20),
    ])
    weeklyProgress.value = progressResp.progress
    weeklySettings.value = settingsResp
    weeklyPlan.value = planResp.plan
    weeklyHistory.value = historyResp.items
    if (
      weeklyOutput.value &&
      weeklyOutput.value.snapshot.plan_revision !== planResp.plan.revision
    ) {
      weeklyOutput.value = null
      weeklyDelivery.reset()
    }
    weeklyPlanIntent.value = null
  } catch (cause) {
    weeklyError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    weeklyLoading.value = false
  }
}

async function prepareWeeklyOutput() {
  const plan = weeklyPlan.value
  if (!plan || weeklyBusy.value) return
  weeklyBusy.value = true
  try {
    weeklyOutput.value = await k12PrepareWeeklyPracticeOutput(
      props.agentId,
      plan.plan_id,
      plan.revision,
      weeklyCommandKey('prepare', `${plan.plan_id}:${plan.revision}`),
    )
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause))
  } finally {
    weeklyBusy.value = false
  }
}

async function runWeeklyArtifactAction(intent: {
  action: 'print' | 'export_pdf' | 'send_im'
  artifact_digest: string
}) {
  const output = weeklyOutput.value
  if (!output || weeklyBusy.value) return
  weeklyBusy.value = true
  try {
    if (intent.action === 'print') {
      await weeklyPrintController.value?.open({
        agent: props.agentId,
        idempotencyKey: weeklyCommandKey('print', output.artifact.artifact_id),
        sourceKind: 'weekly_practice_snapshot',
        sourceRef: output.snapshot.snapshot_id,
        title: output.artifact.title,
        artifactId: output.artifact.artifact_id,
        browserPrint: async () => {
          toast.error('当前环境没有可核验的系统打印边界')
          return false
        },
      })
      return
    }
    if (intent.action === 'export_pdf') {
      const pdf = await k12GetPrintArtifactContent(
        props.agentId,
        output.artifact.artifact_id,
      )
      await savePdfArtifact(pdf, output.artifact.title)
      return
    }
    await weeklyDelivery.send(() =>
      k12SendWeeklyPracticeSnapshot(
        props.agentId,
        output.snapshot.snapshot_id,
        weeklyCommandKey('send', output.snapshot.snapshot_id),
      ),
    )
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause))
  } finally {
    weeklyBusy.value = false
  }
}

async function saveWeeklyPracticeSet() {
  const plan = weeklyPlan.value
  if (!plan || weeklyBusy.value) return
  weeklyBusy.value = true
  try {
    const response = await k12SaveWeeklyPracticePlanToPracticeSet(
      props.agentId,
      plan.plan_id,
      plan.revision,
      weeklyCommandKey('save', `${plan.plan_id}:${plan.revision}`),
    )
    toast.success(response.replayed ? '这份周练已在练习集中' : '已保存到练习集')
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause))
  } finally {
    weeklyBusy.value = false
  }
}

function openWeeklyProfile() {
  if (!profileAgent.value) {
    toast.error('无法读取当前辅导助手档案')
    return
  }
  profileOpen.value = true
}

async function onWeeklyProfileSaved() {
  profileOpen.value = false
  weeklyPlanIntent.value = null
  await loadWeeklyPractice()
}

// IA 定稿（PRD §1.5，2026-07-18 迁移）：学习档案五对象 Tab——本周复习(行动)｜全部错题(档案)｜
// 练习集｜积累｜作品；学情已提升为顶栏一等 Tab（K12InsightPanel）。默认落在「本周复习」（行动优先）。
const sub = ref<K12RecordsTarget>(props.navigation?.target ?? props.target ?? 'week')
const reviewMenuOpen = ref(false)
watch(
  () => props.target,
  (target) => {
    if (target) sub.value = target
  },
)
watch(sub, () => {
  reviewMenuOpen.value = false
  exportOpen.value = false
})
const creativeWorksRef = ref<InstanceType<typeof K12CreativeWorksPanel>>()

// 对象 Tab 计数与原型一致：本周=到期队列，错题=全部档案，练习集=待打印篮，积累=全部收藏，作品=全部作品。
// 练习集面板每次真实 load 后会回推最新篮数；作品当前为自包含面板，父层只读列表总数用于导航计数。
const practiceCount = ref(0)
const accumulationTotalCount = ref(0)
const worksCount = ref(0)
const objectCountsLoading = ref(true)
const objectCountsError = ref(false)
const practiceObjectEmpty = ref(false)
const worksObjectEmpty = ref(false)
let objectCountRequest = 0

type ArchiveUndo = {
  agentId: string
  recordId: string
  version: number
  timer: ReturnType<typeof setTimeout>
}
const archiveUndo = ref<ArchiveUndo | null>(null)
const archiveBusy = ref<string[]>([])
let archiveIntentSequence = 0
let latestArchiveUndoIntent = 0

function removeArchiveUndo(recordId?: string) {
  if (!archiveUndo.value || (recordId && archiveUndo.value.recordId !== recordId)) return
  clearTimeout(archiveUndo.value.timer)
  archiveUndo.value = null
}

function clearArchiveUndos() {
  removeArchiveUndo()
}

function exposeArchiveUndo(recordId: string, version: number, agentId: string) {
  removeArchiveUndo()
  const timer = setTimeout(() => removeArchiveUndo(recordId), 8_000)
  archiveUndo.value = { agentId, recordId, version, timer }
}

function setArchiveBusy(recordId: string, busy: boolean) {
  archiveBusy.value = busy
    ? [...new Set([...archiveBusy.value, recordId])]
    : archiveBusy.value.filter((id) => id !== recordId)
}

// 五对象计数是导航增强信息：独立请求、独立 settle，不得让任一计数失败阻断错题/积累主内容。
async function fetchPracticeSetsForCount() {
  return k12ListPracticeSets(props.agentId)
}
async function fetchCreativeWorksForCount() {
  return k12ListCreativeWorks(props.agentId)
}
async function reloadObjectCounts() {
  const request = ++objectCountRequest
  objectCountsLoading.value = true
  objectCountsError.value = false
  const [practiceResult, worksResult] = await Promise.allSettled([
    fetchPracticeSetsForCount(),
    fetchCreativeWorksForCount(),
  ])
  if (request !== objectCountRequest) return
  if (practiceResult.status === 'fulfilled') {
    const draft = practiceResult.value.items.find((item) => item.status === 'draft')
    practiceCount.value = draft?.items.length ?? 0
    practiceObjectEmpty.value = practiceResult.value.items.length === 0
  }
  if (worksResult.status === 'fulfilled') {
    worksCount.value = worksResult.value.items.length
    worksObjectEmpty.value = worksResult.value.items.length === 0
  }
  objectCountsError.value =
    practiceResult.status === 'rejected' || worksResult.status === 'rejected'
  objectCountsLoading.value = false
}

// 积累本分科过滤（#5）：''=全部 / '语文' / '英语'，触达后端 GET /accumulation?subject=（BUG-3）。
const accumSubject = ref('')
const accumulationLoading = ref(true)
let accumulationLoadRequest = 0
async function reloadAccum() {
  const request = ++accumulationLoadRequest
  accumulationLoading.value = true
  try {
    await store.loadAccumulation(props.agentId, accumSubject.value || undefined)
    if (request !== accumulationLoadRequest) return
    if (!accumSubject.value && store.accumView) {
      accumulationTotalCount.value = store.accumView.items.length
    }
  } finally {
    if (request === accumulationLoadRequest) accumulationLoading.value = false
  }
}
function setAccumSubject(s: string) {
  if (accumSubject.value === s) return
  accumSubject.value = s
  reloadAccum()
}

const mistakesLoading = ref(true)
async function reloadMistakes() {
  mistakesLoading.value = true
  try {
    await store.loadMistakes(props.agentId)
    await reloadPracticeGenerationStates()
  } finally {
    mistakesLoading.value = false
  }
}

async function reload() {
  if (!props.agentId) return
  await Promise.all([
    loadWeeklyPractice(),
    reloadMistakes(),
    store.loadReport(props.agentId), // trend pill（本周复习行动卡）数据源；学情全量在 K12InsightPanel
    reloadAccum(),
    reloadObjectCounts(),
  ])
}
onMounted(reload)
watch(
  () => props.active,
  (active, previous) => {
    if (active && !previous) void reload()
  },
)
// 切实例（多孩）→ 重置分科过滤 + 收起记录表单 + 清庆祝态，避免带上一个孩子的会话态
watch(
  () => props.agentId,
  () => {
    clearArchiveUndos()
    archiveBusy.value = []
    resetPracticeGenerationProjection()
    // 删除确认与被确认对象必须随辅导对象切换一并销毁，避免旧对象的
    // 冷却计时器、焦点恢复或迟到响应污染新对象。
    closeDetail()
    accumSubject.value = ''
    mistakeSubject.value = ''
    mistakeStatus.value = 'all'
    accumAddOpen.value = false
    clearedThisSession.value = false
    practiceCount.value = 0
    accumulationTotalCount.value = 0
    worksCount.value = 0
    practiceObjectEmpty.value = false
    worksObjectEmpty.value = false
    objectCountsError.value = false
    objectCountsLoading.value = true
    reload()
  },
)

onBeforeUnmount(clearArchiveUndos)

// 手动记积累本（#4）：家长在会话里遇到好东西 → 直接记进积累本（PRD §3.13）。
// 学情相关（本月辅导次数/学期分科/薄弱条/完成率）已随 IA 迁移抽到 K12InsightPanel（顶栏一等 Tab）。

const accumAddOpen = ref(false)
const accumForm = ref({ content: '' })
const accumSaving = ref(false)
const accumCreateIdempotencyKey = ref('')
let accumCreateKeySequence = 0

function newAccumCreateKey(agent = props.agentId): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `desktop-accum-create:${agent}:${uuid ?? `${Date.now()}-${++accumCreateKeySequence}`}`
}

function rotateAccumCreateKey() {
  accumCreateIdempotencyKey.value = newAccumCreateKey()
}

watch(
  () => props.agentId,
  () => rotateAccumCreateKey(),
  { immediate: true },
)

async function submitAccum() {
  const content = accumForm.value.content.trim()
  if (!content || accumSaving.value) return
  const idempotencyKey = accumCreateIdempotencyKey.value || newAccumCreateKey()
  accumSaving.value = true
  try {
    await k12AddAccumulation(props.agentId, { content }, idempotencyKey)
    toast.success(t('k12.accum.added'))
    accumForm.value.content = ''
    rotateAccumCreateKey()
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
const mistakeSubjectOptions = computed(() =>
  K12_GRADE_SUBJECT_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  })),
)
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
      .split(/[·,，、/]/)
      .map((s) => s.trim())
      .filter(Boolean)
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

// 自定义组卷（DD-027A）：失败时保留请求快照和 idempotency_key；原地重试同一正式命令，
// 使“服务端已提交、客户端丢响应”能读取同一 committed 回执，不重复装篮。
const customPaperOpen = ref(false)
const paperForm = ref<{
  scope: CustomPaperScope
  perQ: 1 | 2 | 3
  difficulty: CustomPaperDifficulty
  total: CustomPaperTotal
}>({ scope: 'week', perQ: 1, difficulty: 'same', total: 'all' })
const customPaperError = ref('')
const customPaperResult = ref<CustomPaperResp | null>(null)
const customPaperIdempotencyKey = ref('')
let customPaperKeySequence = 0

function newCustomPaperKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `desktop-custom-paper:${props.agentId}:${uuid ?? `${Date.now()}-${++customPaperKeySequence}`}`
}

function closeCustomPaper() {
  if (basketBusy.value) return
  customPaperOpen.value = false
}

watch(
  paperForm,
  () => {
    if (basketBusy.value) return
    customPaperError.value = ''
    customPaperResult.value = null
    customPaperIdempotencyKey.value = newCustomPaperKey()
  },
  { deep: true },
)

const gradeBoundary = computed(() => props.grade.split('·')[0]?.trim() ?? '')
const textbookBoundary = computed(
  () => props.textbook?.trim() || props.grade.split('·').slice(1).join('·').trim(),
)
const paperScopeOpts = computed(() => [
  { v: 'week' as const, label: t('k12.customPaper.scopeWeek') },
  { v: 'unmastered' as const, label: t('k12.customPaper.scopeUnmastered') },
])
const paperPerQOpts = [1, 2, 3] as const
const paperDiffOpts = computed(() => [
  { v: 'same' as const, label: t('k12.customPaper.diffSame') },
  { v: 'easier' as const, label: t('k12.customPaper.diffEasier') },
  { v: 'harder' as const, label: t('k12.customPaper.diffHarder') },
])
const paperTotalOpts = computed(() => [
  { v: 'all' as const, label: t('k12.customPaper.totalAll') },
  { v: 5 as const, label: '≤ 5' },
  { v: 10 as const, label: '≤ 10' },
])
function paperDifficultyLabel(value: CustomPaperDifficulty): string {
  return paperDiffOpts.value.find((option) => option.v === value)?.label ?? value
}
async function genCustomPaper() {
  if (basketBusy.value) return
  if (!textbookBoundary.value) {
    customPaperError.value = t('k12.customPaper.textbookRequired')
    return
  }
  customPaperError.value = ''
  customPaperResult.value = null
  if (!customPaperIdempotencyKey.value) customPaperIdempotencyKey.value = newCustomPaperKey()
  basketBusy.value = true
  try {
    const result = await k12GenerateCustomPaper({
      agent: props.agentId,
      idempotency_key: customPaperIdempotencyKey.value,
      scope: paperForm.value.scope,
      total: paperForm.value.total,
      per_source: paperForm.value.perQ,
      difficulty: paperForm.value.difficulty,
      textbook: textbookBoundary.value,
      ...(gradeBoundary.value ? { grade: gradeBoundary.value } : {}),
      ...(props.modelRoute
        ? { provider: props.modelRoute.provider, model: props.modelRoute.model }
        : {}),
    })
    if (result.status !== 'committed') throw new Error(t('k12.customPaper.notCommitted'))
    customPaperResult.value = result
  } catch (e) {
    customPaperError.value = e instanceof Error ? e.message : String(e)
  } finally {
    basketBusy.value = false
  }
}

function viewCustomPaperBasket() {
  customPaperOpen.value = false
  sub.value = 'practiceSets'
}

const view = computed(() => store.mistakeView)
const accumView = computed(() => store.accumView)
const weekCount = computed(() =>
  (weeklyPlan.value?.tracks ?? []).reduce(
    (count, track) =>
      count + track.items.filter((item) => item.verification.status === 'verified').length,
    0,
  ),
)
const mistakeCount = computed(
  () => view.value?.items.filter((item) => item.status !== 'archived').length ?? 0,
)
const archivedMistakeCount = computed(
  () => view.value?.items.filter((item) => item.status === 'archived').length ?? 0,
)

function updatePracticeCount(count: number) {
  practiceCount.value = count
}
function updateWorksCount(count: number) {
  worksCount.value = count
}

// 全部错题的两维筛选严格按原型：学科与状态可以叠加，结果数始终显示「当前 / 全部」。
// new + explained 同属家长视角的「待复习」，避免把领域中间态抬成第六个筛选按钮。
const mistakeSubject = ref('')
const mistakeStatus = ref<K12MistakeStatusFilter>('all')
watch(
  () => props.subject,
  (subject) => {
    mistakeSubject.value = subject ?? ''
  },
  { immediate: true },
)
watch(
  () => props.status,
  (status) => {
    mistakeStatus.value = status ?? 'all'
  },
  { immediate: true },
)
watch(
  () => props.navigation,
  (next) => {
    if (!next) return
    sub.value = next.target
    mistakeSubject.value = next.subject
    mistakeStatus.value = next.status
  },
  { immediate: true },
)
const mistakeSubjectFilters = computed(() => [
  { value: '', label: t('records.all') },
  ...K12_GRADE_SUBJECT_OPTIONS.map(({ value, plainLabelKey }) => ({
    value,
    label: t(plainLabelKey),
  })),
])
const mistakeStatusFilters = computed(() => [
  { value: 'all' as const, label: t('records.all') },
  { value: 'review' as const, label: t('k12.mistakeStatus.new') },
  { value: 'retried' as const, label: t('k12.mistakeStatus.retried') },
  { value: 'mastered' as const, label: t('k12.mistakeStatus.mastered') },
  { value: 'archived' as const, label: t('k12.mistakeStatus.archived') },
])

function mistakeSubjectOf(item: RecordItem): string {
  const explicit = String(item.fields.subject ?? '').trim()
  if (explicit) return explicit
  const chip = String(item.fields.knowledge_point ?? '')
  return K12_GRADE_SUBJECT_OPTIONS.find(({ value }) => chip.startsWith(`${value}·`))?.value ?? ''
}

function matchesMistakeStatus(item: RecordItem): boolean {
  if (mistakeStatus.value === 'all') return item.status !== 'archived'
  if (mistakeStatus.value === 'review') return item.status === 'new' || item.status === 'explained'
  return item.status === mistakeStatus.value
}

const mistakeResultTotal = computed(() =>
  mistakeStatus.value === 'archived' ? archivedMistakeCount.value : mistakeCount.value,
)

const filteredMistakeItems = computed(() =>
  (view.value?.items ?? []).filter(
    (item) =>
      (!mistakeSubject.value || mistakeSubjectOf(item) === mistakeSubject.value) &&
      matchesMistakeStatus(item),
  ),
)
const filteredMistakeView = computed<RecordCollectionView | null>(() => {
  if (!view.value) return null
  return { ...view.value, items: filteredMistakeItems.value }
})

// 项-5：空态设计——复习队列（本周复习）常空时不留尴尬空白。
// 折叠机制随旧两段 IA 退役（2026-07-18）：本周复习=行动页（hide-list）、全部错题=档案页（hide-review），
// 不再有「档案折叠在行动卡下方」的形态。
// 本周清零庆祝态（§3.6 / 原型 k12WeekClearState）：清零是一周唯一的正反馈时刻——
// 空态区分「本轮有做对清零」（庆祝）vs「本来就无到期」（中性计划文案）。
// DTO 无状态变更时间戳（无法判「今天 retried/mastered」），先以会话内清零动作近似：
// 本会话「家长确认已会」把队列里的题清掉且队列随之清空 → 庆祝（后端下发 updated_at 后可升级为按日判定，
// 当前会话内近似仅影响庆祝时机粒度，不影响正确性）。
const clearedThisSession = ref(false)
function isInReviewQueue(recordId: string): boolean {
  return view.value?.reviewQueue?.includes(recordId) ?? false
}

// 复习完成率/薄弱条已随 IA 迁移抽到 K12InsightPanel（学情=顶栏一等 Tab）。

async function onAction(payload: {
  id: 'markMastered' | 'detail'
  record: RecordItem
}) {
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
  } else if (id === 'detail') {
    openDetail(record)
  }
}

async function archiveMistake(record: RecordItem) {
  const agent = props.agentId
  if (!agent || archiveBusy.value.includes(record.recordId) || record.status === 'archived') return
  const intent = ++archiveIntentSequence
  setArchiveBusy(record.recordId, true)
  try {
    const archived = await store.archiveMistake(agent, record.recordId, record.version)
    if (props.agentId !== agent) return
    // 多条归档可并发；Undo 归属按用户发起顺序，而不是网络响应顺序。
    // 较早请求的迟到成功不得覆盖较晚成功动作的唯一 Undo。
    if (intent >= latestArchiveUndoIntent) {
      latestArchiveUndoIntent = intent
      exposeArchiveUndo(record.recordId, archived.version, agent)
    }
    if (detail.value.record?.recordId === record.recordId) closeDetail()
    void store.calibrateMistakes(agent)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    if (props.agentId === agent) void store.calibrateMistakes(agent)
  } finally {
    setArchiveBusy(record.recordId, false)
  }
}

async function restoreMistake(recordId: string, version: number, undo = false) {
  const agent = props.agentId
  if (!agent || archiveBusy.value.includes(recordId)) return
  setArchiveBusy(recordId, true)
  try {
    await store.restoreMistake(agent, recordId, version)
    if (props.agentId !== agent) return
    removeArchiveUndo(recordId)
    if (detail.value.record?.recordId === recordId) closeDetail()
    toast.success(t(undo ? 'k12.records.archiveUndone' : 'k12.records.restoreSucceeded'))
    void store.calibrateMistakes(agent)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    if (props.agentId === agent) void store.calibrateMistakes(agent)
  } finally {
    setArchiveBusy(recordId, false)
  }
}

function restoreArchivedRecord(record: RecordItem) {
  if (record.status !== 'archived') return
  void restoreMistake(record.recordId, record.version)
}

function undoArchive(undo: ArchiveUndo) {
  if (undo.agentId !== props.agentId) return
  void restoreMistake(undo.recordId, undo.version, true)
}

// ── 错题 → 练习集：服务端持久化的一键异步投影 ─────────────────────
// 产品裁决（2026-07-25）：列表里一次点击完成“生成 → 验证 → 装篮”。桌面端不再保存临时
// 题答、不再弹第二次加入按钮；切 Tab、切会话或重启后均从服务端恢复五态。
const practiceGenerationByMistake = ref<Record<string, MistakePracticeGenerationDTO>>({})
const practiceGenerationBusy = ref<string[]>([])
const practiceCommandKeys = new Map<string, string>()
const practiceTarget = ref<{
  practiceSetID: string
  practiceItemID: string
  nonce: number
} | null>(null)
let practiceProjectionRequest = 0
let practiceCommandSequence = 0
let practicePollTimer: ReturnType<typeof setTimeout> | null = null

function practiceProjection(recordID: string): MistakePracticeGenerationDTO | undefined {
  return practiceGenerationByMistake.value[recordID]
}

function practiceActionLabel(recordID: string): string {
  const state = practiceProjection(recordID)?.state
  if (state === 'failed') return '出题失败，重试'
  if (state === 're_add') return '再次加入练习集'
  return '加入练习集'
}

function setPracticeProjection(next: MistakePracticeGenerationDTO) {
  practiceGenerationByMistake.value = {
    ...practiceGenerationByMistake.value,
    [next.source_mistake_id]: next,
  }
  if (next.state !== 'pending') practiceCommandKeys.delete(next.source_mistake_id)
}

function setPracticeBusy(recordID: string, busy: boolean) {
  practiceGenerationBusy.value = busy
    ? [...new Set([...practiceGenerationBusy.value, recordID])]
    : practiceGenerationBusy.value.filter((id) => id !== recordID)
}

function newPracticeCommandKey(recordID: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++practiceCommandSequence}`
  return `desktop-single-practice:${props.agentId}:${recordID}:${nonce}`
}

function clearPracticePoll() {
  if (practicePollTimer) clearTimeout(practicePollTimer)
  practicePollTimer = null
}

function schedulePracticePoll() {
  clearPracticePoll()
  const hasPending = Object.values(practiceGenerationByMistake.value).some(
    (projection) => projection.state === 'pending',
  )
  if (!hasPending || props.active === false) return
  practicePollTimer = setTimeout(() => {
    practicePollTimer = null
    void pollPendingPracticeGenerations()
  }, 1_500)
}

async function pollPendingPracticeGenerations() {
  const agent = props.agentId
  const pendingIDs = Object.values(practiceGenerationByMistake.value)
    .filter((projection) => projection.state === 'pending')
    .map((projection) => projection.source_mistake_id)
  if (!agent || !pendingIDs.length) return
  const results = await Promise.allSettled(
    pendingIDs.map((recordID) => k12GetMistakePracticeGeneration(agent, recordID)),
  )
  if (props.agentId !== agent) return
  let reachedJoined = false
  results.forEach((result) => {
    if (result.status !== 'fulfilled') return
    setPracticeProjection(result.value)
    if (result.value.state === 'joined') reachedJoined = true
  })
  if (reachedJoined) void reloadObjectCounts()
  schedulePracticePoll()
}

async function reloadPracticeGenerationStates() {
  const agent = props.agentId
  const recordIDs = store.mistakeView?.items.map((item) => item.recordId) ?? []
  const request = ++practiceProjectionRequest
  clearPracticePoll()
  if (!agent || !recordIDs.length) {
    practiceGenerationByMistake.value = {}
    return
  }
  const results = await Promise.allSettled(
    recordIDs.map((recordID) => k12GetMistakePracticeGeneration(agent, recordID)),
  )
  if (request !== practiceProjectionRequest || props.agentId !== agent) return
  const next: Record<string, MistakePracticeGenerationDTO> = {}
  results.forEach((result) => {
    if (result.status === 'fulfilled') next[result.value.source_mistake_id] = result.value
  })
  practiceGenerationByMistake.value = next
  schedulePracticePoll()
}

function resetPracticeGenerationProjection() {
  practiceProjectionRequest++
  clearPracticePoll()
  practiceGenerationByMistake.value = {}
  practiceGenerationBusy.value = []
  practiceCommandKeys.clear()
  practiceTarget.value = null
}

async function runPracticeGeneration(record: RecordItem) {
  const recordID = record.recordId
  const projection = practiceProjection(recordID)
  if (
    !projection ||
    practiceGenerationBusy.value.includes(recordID) ||
    projection.state === 'pending' ||
    projection.state === 'joined' ||
    projection.state === 'hidden'
  ) {
    return
  }
  const agent = props.agentId
  setPracticeBusy(recordID, true)
  try {
    const next =
      projection.state === 'failed'
        ? await k12RetryMistakePracticeGeneration(agent, recordID)
        : await k12StartMistakePracticeGeneration({
            agent,
            record_id: recordID,
            idempotency_key:
              practiceCommandKeys.get(recordID) ??
              (() => {
                const key = newPracticeCommandKey(recordID)
                practiceCommandKeys.set(recordID, key)
                return key
              })(),
            ...(gradeBoundary.value ? { grade: gradeBoundary.value } : {}),
            ...(textbookBoundary.value ? { textbook: textbookBoundary.value } : {}),
            difficulty: 'same',
            ...(props.modelRoute
              ? { provider: props.modelRoute.provider, model: props.modelRoute.model }
              : {}),
          })
    if (props.agentId !== agent) return
    setPracticeProjection(next)
    if (next.state === 'joined') void reloadObjectCounts()
    schedulePracticePoll()
  } catch (error) {
    if (props.agentId !== agent) return
    // 请求结果未知时先用同一来源查询正式状态；查询也失败才向用户报告。
    try {
      const recovered = await k12GetMistakePracticeGeneration(agent, recordID)
      if (props.agentId !== agent) return
      setPracticeProjection(recovered)
      schedulePracticePoll()
    } catch {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    setPracticeBusy(recordID, false)
  }
}

function viewGeneratedPractice(recordID: string) {
  const projection = practiceProjection(recordID)
  if (
    projection?.state !== 'joined' ||
    !projection.practice_set_id ||
    !projection.practice_item_id
  ) {
    return
  }
  practiceTarget.value = {
    practiceSetID: projection.practice_set_id,
    practiceItemID: projection.practice_item_id,
    nonce: Date.now(),
  }
  sub.value = 'practiceSets'
}

onBeforeUnmount(resetPracticeGenerationProjection)

// ── 详情弹层（BUG-20260712-#2）──
// 复用列表已有的 RecordItem 字段，不额外请求后端，弹层可关闭。kind 区分错题（题目/知识点/错因）
// 与积累（内容/学科/类型），走各自 schema 状态机上色。
const detail = ref<{ open: boolean; record: RecordItem | null; kind: 'mistake' | 'accum' }>({
  open: false,
  record: null,
  kind: 'mistake',
})
const detailCard = ref<HTMLElement | null>(null)
const confirmDelete = ref(false)
const accumulationDeleteReturnState = ref<{
  recordID: string
  scrollTop: number
} | null>(null)
const accumulationDeleteConfirmActive = computed(
  () => confirmDelete.value && detail.value.kind === 'accum',
)

function openDetail(record: RecordItem, kind: 'mistake' | 'accum' = 'mistake') {
  accumulationDelivery.reset()
  confirmDelete.value = false
  accumulationDeleteReturnState.value = null
  detail.value = { open: true, record, kind }
}
function closeDetail() {
  accumulationDelivery.reset()
  confirmDelete.value = false
  accumulationDeleteReturnState.value = null
  detail.value = { open: false, record: null, kind: 'mistake' }
}
const detailQuestion = computed(() => String(detail.value.record?.fields.question ?? ''))
const detailKp = computed(() => String(detail.value.record?.fields.knowledge_point ?? ''))
const detailError = computed(() => String(detail.value.record?.fields.error_cause ?? ''))
// 抽查复验（§3.6 规则 4）：复验未过的题在档案留「家长确认（复验未过）」事实标注——
// 只呈现 failed；scheduled/passed 不呈现（不打抽查标签、不制造紧张感）。话术温和不指责。
const detailSpotCheckFailed = computed(
  () => detail.value.record?.fields.spot_check_state === 'failed',
)
// 积累本字段
const detailContent = computed(() => String(detail.value.record?.fields.content ?? ''))
const detailAccumSubject = computed(() => String(detail.value.record?.fields.subject ?? ''))
const detailAccumType = computed(() => String(detail.value.record?.fields.entry_type ?? ''))
const detailAccumSource = computed(() => String(detail.value.record?.fields.source ?? ''))
// 收藏日期（原型 acc-date）：fields.created_at（unix 秒字符串）→ MM-DD；旧后端无字段时不显示
function accumDate(item: RecordItem): string {
  const ts = Number(item.fields.created_at ?? '')
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function accumField(
  item: RecordItem,
  key: 'subject' | 'entry_type' | 'content' | 'source',
): string {
  return String(item.fields[key] ?? '')
}
function accumSourceLabel(item: RecordItem): string {
  const source = accumField(item, 'source')
  return source ? `${t('k12.accumulationFields.source')}：${source}` : ''
}
const detailStatus = computed(() => {
  if (detail.value.kind === 'accum') return ''
  const s = detail.value.record?.status
  if (!s) return '—'
  const st = MISTAKE_SCHEMA.states?.find((x) => x.id === s)
  return st ? t(st.labelKey) : s
})
// 状态色调复用对应 schema 状态机声明（与 RecordList 行内状态徽章同源，零硬编码色映射）。
const detailStatusTone = computed(() => {
  const s = detail.value.record?.status
  return MISTAKE_SCHEMA.states?.find((st) => st.id === s)?.tone ?? 'na'
})
// UX-1：详情弹层「家长确认已会」——已掌握态不显该动作（幂等，与档案行同口径）。
const detailMastered = computed(() => detail.value.record?.status === 'mastered')
const detailArchived = computed(() => detail.value.record?.status === 'archived')
const detailRestorable = computed(
  () => detailArchived.value && detail.value.record?.fields.restorable === true,
)
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

// 积累默写 generation 始终以 GET/POST 返回的 durable 摘要为真相源；组件只保留在途提交锁，
// 不用会话数组冒充持久状态。queued/generating/validating 均为同一 pending 投影。
const ACCUMULATION_DICTATION_STATUSES = new Set<AccumulationDictationStatus>([
  'queued',
  'generating',
  'validating',
  'committed',
  'failed',
])
const dictationBusy = ref<string[]>([])

function accumulationGeneration(
  item: RecordItem | null | undefined,
): AccumulationDictationGenerationDTO | undefined {
  const value = item?.fields.dictation_generation
  if (!value || typeof value !== 'object') return undefined
  const status = (value as { status?: unknown }).status
  if (
    typeof status !== 'string' ||
    !ACCUMULATION_DICTATION_STATUSES.has(status as AccumulationDictationStatus)
  )
    return undefined
  return value as AccumulationDictationGenerationDTO
}

function accumulationDictationPending(item: RecordItem): boolean {
  const status = accumulationGeneration(item)?.status
  return status === 'queued' || status === 'generating' || status === 'validating'
}

function accumulationDictationCommitted(item: RecordItem): boolean {
  return accumulationGeneration(item)?.status === 'committed'
}

function accumulationDictationDisabled(item: RecordItem): boolean {
  return (
    dictationBusy.value.includes(item.recordId) ||
    accumulationDictationPending(item) ||
    accumulationDictationCommitted(item)
  )
}

function accumulationDictationLabel(item: RecordItem): string {
  return t(
    accumulationDictationCommitted(item)
      ? 'k12.accum.dictationAdded'
      : 'k12.accum.dictationToBasket',
  )
}

function setDictationBusy(recordId: string, busy: boolean) {
  dictationBusy.value = busy
    ? [...new Set([...dictationBusy.value, recordId])]
    : dictationBusy.value.filter((id) => id !== recordId)
}

async function copyAccumulationContent() {
  if (!detailContent.value) return
  try {
    await setClipboard(detailContent.value)
    toast.success(t('k12.accum.copied'))
  } catch {
    toast.error(t('k12.accum.copyFailed'))
  }
}
async function sendAccumulationToPhone() {
  const rec = detail.value.record
  if (!rec) return
  await accumulationDelivery.send(() => k12SendAccumulation(props.agentId, rec.recordId))
}
async function dictationToBasket(rec: RecordItem | null = detail.value.record) {
  if (!rec || accumulationDictationDisabled(rec)) return
  setDictationBusy(rec.recordId, true)
  try {
    const response = await k12GenerateAccumulationDictation(props.agentId, rec.recordId)
    rec.fields.dictation_generation = response.dictation_generation
    await reloadAccum()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
    await reloadAccum()
  } finally {
    setDictationBusy(rec.recordId, false)
  }
}

// 详情删除统一复用平台 ConfirmDialog。积累删除额外携带 owner、版本和稳定幂等键；
// 只有服务端确认成功后才关闭详情并刷新当前积累投影。
const deleting = ref(false)
const accumulationDeleteKeys = new Map<string, string>()
let accumulationDeleteSequence = 0

function accumulationDeleteTarget(record: RecordItem): string {
  return `${props.agentId}:${record.recordId}`
}

function accumulationDeleteKey(record: RecordItem): string {
  const target = accumulationDeleteTarget(record)
  const existing = accumulationDeleteKeys.get(target)
  if (existing) return existing
  const created = `desktop-accum-delete:${props.agentId}:${record.recordId}:${Date.now()}-${++accumulationDeleteSequence}`
  accumulationDeleteKeys.set(target, created)
  return created
}

function askDelete() {
  const rec = detail.value.record
  if (!rec) return
  if (detail.value.kind === 'accum') {
    accumulationDeleteKey(rec)
    accumulationDeleteReturnState.value = {
      recordID: rec.recordId,
      scrollTop: detailCard.value?.scrollTop ?? 0,
    }
  }
  confirmDelete.value = true
}

function restoreAccumulationDetail(recordID: string) {
  const saved = accumulationDeleteReturnState.value
  void nextTick(() => {
    if (
      !saved ||
      saved.recordID !== recordID ||
      detail.value.kind !== 'accum' ||
      detail.value.record?.recordId !== recordID
    ) {
      if (accumulationDeleteReturnState.value === saved) {
        accumulationDeleteReturnState.value = null
      }
      return
    }
    if (detailCard.value) detailCard.value.scrollTop = saved.scrollTop
    detailCard.value?.querySelector<HTMLElement>('[data-testid="accum-delete"]')?.focus()
    if (accumulationDeleteReturnState.value === saved) {
      accumulationDeleteReturnState.value = null
    }
  })
}

function cancelDelete() {
  if (deleting.value) return
  const rec = detail.value.record
  const restoreAccumulation = detail.value.kind === 'accum' && !!rec
  confirmDelete.value = false
  if (restoreAccumulation) restoreAccumulationDetail(rec.recordId)
  else accumulationDeleteReturnState.value = null
}

const deleteConfirmTitle = computed(() =>
  t(
    detail.value.kind === 'accum'
      ? 'k12.accum.deleteConfirmTitle'
      : 'k12.detail.deleteConfirmTitle',
  ),
)
const deleteConfirmMessage = computed(() =>
  t(
    detail.value.kind === 'accum'
      ? 'k12.accum.deleteConfirmMessage'
      : 'k12.detail.deleteConfirmMsg',
  ),
)
const deleteConfirmText = computed(() =>
  t(detail.value.kind === 'accum' ? 'k12.accum.delete' : 'k12.detail.deleteConfirmOk'),
)
const deleteConfirmationKey = computed(
  () => `${detail.value.kind}:${props.agentId}:${detail.value.record?.recordId ?? ''}`,
)

async function doDelete() {
  const rec = detail.value.record
  if (!rec || deleting.value) return
  deleting.value = true
  try {
    if (detail.value.kind === 'accum') {
      const target = accumulationDeleteTarget(rec)
      await k12DeleteAccumulation(
        props.agentId,
        rec.recordId,
        rec.version,
        accumulationDeleteKey(rec),
      )
      accumulationDeleteKeys.delete(target)
      accumulationDeleteReturnState.value = null
      confirmDelete.value = false
      closeDetail()
      await reloadAccum()
      return
    }
    await store.deleteMistake(props.agentId, rec.recordId) // 内含 reload
    toast.success(t('k12.detail.deleted'))
    confirmDelete.value = false
    closeDetail()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
    const restoreAccumulation = detail.value.kind === 'accum'
    const recordID = rec.recordId
    confirmDelete.value = false
    if (restoreAccumulation) restoreAccumulationDetail(recordID)
  } finally {
    deleting.value = false
  }
}

// ── 打印 / 导出（M2-3 / M3-5）──
const exportOpen = ref(false)
const recordsMoreTrigger = ref<HTMLButtonElement | null>(null)
const recordsMoreMenu = ref<HTMLElement | null>(null)

function exportMenuItems(): HTMLButtonElement[] {
  return Array.from(
    recordsMoreMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
  )
}

function closeExportMenu(restoreFocus = false) {
  if (!exportOpen.value) return
  exportOpen.value = false
  if (restoreFocus) void nextTick(() => recordsMoreTrigger.value?.focus())
}

async function toggleExportMenu() {
  if (exportOpen.value) {
    closeExportMenu(true)
    return
  }
  exportOpen.value = true
  await nextTick()
  exportMenuItems()[0]?.focus()
}

function onExportMenuKeydown(event: KeyboardEvent) {
  const items = exportMenuItems()
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  let target = -1
  if (event.key === 'ArrowDown') target = (current + 1) % items.length
  else if (event.key === 'ArrowUp') target = (current - 1 + items.length) % items.length
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = items.length - 1
  else if (event.key === 'Escape') {
    event.preventDefault()
    closeExportMenu(true)
    return
  } else return
  event.preventDefault()
  items[target]?.focus()
}

function onRecordsOutsideClick(event: MouseEvent) {
  if (!exportOpen.value) return
  const target = event.target as Node | null
  if (
    target &&
    (recordsMoreTrigger.value?.contains(target) || recordsMoreMenu.value?.contains(target))
  )
    return
  closeExportMenu(true)
}

function openBackupFromMenu() {
  closeExportMenu(false)
  recordsMoreTrigger.value?.focus()
  emit('open-backup')
}

onMounted(() => document.addEventListener('click', onRecordsOutsideClick))
onBeforeUnmount(() => document.removeEventListener('click', onRecordsOutsideClick))

function todayLabel(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}
// 出卷（exportPdf 直出）旧路径已删（20260718 §3.8 改道装篮，见 buildReviewSet）；
// 下方导出仅存档案导出（错题本 PDF/Word/Markdown 档案），非出卷。
async function doExport(format: 'pdf' | 'docx') {
  closeExportMenu(true)
  const d = todayLabel().replace(/-/g, '').slice(4)
  try {
    const res = await k12ExportMd(props.agentId)
    if (res.render_error) throw new Error(res.render_error)
    const title = t('k12.tabs.records')
    await exportArchiveDocument({
      content: res.content,
      format,
      title,
      filename: worksheetFilename(props.agentName, title, d, d, format),
    })
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e)) // 导出失败 surface，不再静默无反应
  }
}
// 导出完整错题本为 Markdown（后端 GET /export 直出 md，含全部记录/状态；补齐审计 #6 未闭环）。
async function doExportMd() {
  closeExportMenu(true)
  try {
    const res = await k12ExportMd(props.agentId)
    const d = todayLabel().replace(/-/g, '').slice(4)
    await download(
      worksheetFilename(props.agentName, t('k12.collections.mistakes'), d, d, 'md'),
      res.content,
      'text/markdown;charset=utf-8',
    )
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="k12rec">
    <!-- 实例上下文头卡（🎓 姓名 + 年级 + 回辅导/辅导要点）由外层 k12enh-tabs 唯一提供；
         此处不再自绘，避免错题本 tab 下姓名/年级重复渲染两遍（BUG-20260708 B8）。 -->

    <!-- 学习档案五对象 Tab（PRD §1.5 IA 定稿）：本周复习 / 全部错题 / 练习集 / 积累 / 作品。
         学情已提升为顶栏一等 Tab，不再是二级 Tab。 -->
    <div class="k12rec__tabs">
      <div class="seg k12rec__object-tabs" role="tablist" :aria-label="t('k12.tabs.records')">
        <button
          role="tab"
          :aria-selected="sub === 'week'"
          :aria-label="`${t('k12.subTabs.week')} ${weekCount}`"
          :class="{ on: sub === 'week' }"
          data-testid="subtab-week"
          @click="sub = 'week'"
        >
          {{ t('k12.subTabs.week') }}
          <span class="k12-tab-count" aria-hidden="true" :data-count="weekCount" />
        </button>
        <button
          role="tab"
          :aria-selected="sub === 'mistakes'"
          :aria-label="`${t('k12.subTabs.mistakes')} ${mistakeCount}`"
          :class="{ on: sub === 'mistakes' }"
          data-testid="subtab-mistakes"
          @click="sub = 'mistakes'"
        >
          {{ t('k12.subTabs.mistakes') }}
          <span class="k12-tab-count" aria-hidden="true" :data-count="mistakeCount" />
        </button>
        <button
          role="tab"
          :aria-selected="sub === 'practiceSets'"
          :aria-label="`${t('k12.subTabs.practiceSets')} ${practiceCount}`"
          :class="{ on: sub === 'practiceSets' }"
          data-testid="subtab-practicesets"
          @click="sub = 'practiceSets'"
        >
          {{ t('k12.subTabs.practiceSets') }}
          <span class="k12-tab-count" aria-hidden="true" :data-count="practiceCount" />
        </button>
        <button
          role="tab"
          :aria-selected="sub === 'accumulation'"
          :aria-label="`${t('k12.subTabs.accumulation')} ${accumulationTotalCount}`"
          :class="{ on: sub === 'accumulation' }"
          data-testid="subtab-accumulation"
          @click="sub = 'accumulation'"
        >
          {{ t('k12.subTabs.accumulation') }}
          <span class="k12-tab-count" aria-hidden="true" :data-count="accumulationTotalCount" />
        </button>
        <button
          role="tab"
          :aria-selected="sub === 'works'"
          :aria-label="`${t('k12.subTabs.works')} ${worksCount}`"
          :class="{ on: sub === 'works' }"
          data-testid="subtab-works"
          @click="sub = 'works'"
        >
          {{ t('k12.subTabs.works') }}
          <span class="k12-tab-count" aria-hidden="true" :data-count="worksCount" />
        </button>
      </div>
      <!-- 20260719 信息架构定稿：①功能位 emoji → 单色描边图标；②导出与备份/恢复均为学习档案级动作，
           不占常驻顶栏，统一收进五个子页均可达的「⋯」溢出菜单。 -->
      <button
        v-if="sub === 'mistakes'"
        class="btn k12rec__addbtn"
        data-testid="mistake-add-open"
        @click="mistakeAddOpen = !mistakeAddOpen"
      >
        <svg class="k12ic" viewBox="0 0 24 24">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
        {{ t('k12.mistakeAdd.open') }}
      </button>
      <button
        v-else-if="sub === 'accumulation'"
        class="btn k12rec__addbtn"
        data-testid="accum-add-open"
        @click="accumAddOpen = true"
      >
        <svg class="k12ic" viewBox="0 0 24 24">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        {{ t('k12.accum.addOpen') }}
      </button>
      <button
        v-else-if="sub === 'works'"
        class="btn k12rec__addbtn"
        data-testid="cw-add-open"
        @click="creativeWorksRef?.openAdd()"
      >
        <svg class="k12ic" viewBox="0 0 24 24">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        {{ t('k12.works.addWork') }}
      </button>
      <div class="k12rec__export">
        <button
          ref="recordsMoreTrigger"
          type="button"
          class="btn"
          :title="t('k12.actions.more')"
          aria-haspopup="menu"
          :aria-expanded="exportOpen"
          aria-controls="k12-records-more-menu"
          data-testid="records-more-trigger"
          @click="toggleExportMenu"
        >
          ⋯
        </button>
        <div
          v-if="exportOpen"
          id="k12-records-more-menu"
          ref="recordsMoreMenu"
          class="k12rec__menu"
          role="menu"
          data-testid="records-more-menu"
          @keydown="onExportMenuKeydown"
        >
          <button type="button" role="menuitem" @click="doExport('pdf')">
            {{ t('k12.actions.export') }} PDF
          </button>
          <button type="button" role="menuitem" @click="doExport('docx')">
            {{ t('k12.actions.export') }} Word
          </button>
          <button type="button" role="menuitem" @click="doExportMd">
            {{ t('k12.actions.export') }} Markdown
          </button>
          <button type="button" role="menuitem" @click="openBackupFromMenu">
            {{ t('k12.actions.backup') }}
          </button>
        </div>
      </div>
    </div>

    <div class="k12rec__body">
      <!-- 本周该练：服务端唯一周计划投影。无后端/失败时只显示真实错误，不回退本地错题拼卷。 -->
      <section v-if="sub === 'week'" data-testid="week-section">
        <K12WeeklyPracticePanel
          :progress="weeklyProgress"
          :settings="weeklySettings"
          :plan="weeklyPlan"
          :history="weeklyHistory"
          :output="weeklyOutput"
          :loading="weeklyLoading"
          :busy="weeklyBusy"
          :error="weeklyError"
          :delivery-label="weeklyDelivery.label.value"
          :delivery-disabled="weeklyDelivery.disabled.value"
          @retry="loadWeeklyPractice"
          @open-progress="openWeeklyProfile"
          @prepare-output="prepareWeeklyOutput"
          @artifact-action="runWeeklyArtifactAction"
          @save-to-practice-set="saveWeeklyPracticeSet"
        />
        <K12PersistentPrintController
          ref="weeklyPrintController"
          @error="toast.error($event.message)"
        />
        <K12ProfileForm
          v-if="profileOpen && profileAgent"
          :agent="profileAgent"
          focus-math-progress
          enable-textbook-consolidation
          @created="onWeeklyProfileSaved"
          @close="profileOpen = false"
          @removed="profileOpen = false"
        />
      </section>

      <!-- 全部错题（档案页，PRD §3.7）：查找、核对、管理——直接展开筛选 + 全量，不与本周复习重复行动。 -->
      <section v-else-if="sub === 'mistakes'" data-testid="mistakes-section">
        <div
          v-if="mistakesLoading && !store.mistakeView"
          class="k12rec__loading"
          role="status"
          data-testid="records-loading"
        >
          {{ t('common.loading') }}
        </div>
        <div
          v-else-if="store.mistakesError"
          class="k12rec__err"
          role="alert"
          data-testid="mistakes-error"
        >
          <span>{{ store.mistakesError }}</span>
          <button class="btn btn-ghost" data-testid="mistakes-retry" @click="reloadMistakes">
            {{ t('common.retry') }}
          </button>
        </div>
        <template v-else-if="view && filteredMistakeView">
          <div class="k12rec__object-summary">
            <p class="k12rec__object-description">{{ t('k12.records.archiveDesc') }}</p>
            <span
              class="k12rec__result-count"
              role="status"
              aria-live="polite"
              data-testid="mistake-result-count"
              >{{
                t('k12.records.resultCount', {
                  shown: filteredMistakeItems.length,
                  total: mistakeResultTotal,
                })
              }}</span
            >
          </div>
          <div class="k12rec__filter-stack" :aria-label="t('k12.records.filterLabel')">
            <div
              class="k12rec__filter-row k12rec__filter-row--subject"
              role="group"
              :aria-label="t('k12.records.filterSubject')"
            >
              <span class="k12rec__filter-label">{{ t('k12.records.filterSubject') }}</span>
              <button
                v-for="option in mistakeSubjectFilters"
                :key="option.value || 'all'"
                type="button"
                class="k12rec__filter"
                :class="{ on: mistakeSubject === option.value }"
                :aria-pressed="mistakeSubject === option.value"
                :data-testid="`mistake-subject-${option.value || 'all'}`"
                @click="mistakeSubject = option.value"
              >
                {{ option.label }}
              </button>
            </div>
            <div
              class="k12rec__filter-row"
              role="group"
              :aria-label="t('k12.records.filterStatus')"
            >
              <span class="k12rec__filter-label">{{ t('k12.records.filterStatus') }}</span>
              <button
                v-for="option in mistakeStatusFilters"
                :key="option.value"
                type="button"
                class="k12rec__filter"
                :class="{ on: mistakeStatus === option.value }"
                :aria-pressed="mistakeStatus === option.value"
                :data-testid="`mistake-status-${option.value}`"
                @click="mistakeStatus = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <p class="k12rec__hint k12rec__archive-note">{{ t('k12.records.stateMachineHint') }}</p>
          <div class="k12mistakes">
            <RecordList
              :schema="MISTAKE_SCHEMA"
              :view="filteredMistakeView"
              hide-review
              hide-filters
              @action="onAction"
            >
              <template #list-practice-action="{ item }">
                <span
                  v-if="practiceProjection(item.recordId)?.state === 'pending'"
                  class="rl-status rl-status--todo"
                  :data-testid="`mistake-practice-state-${item.recordId}`"
                  >已加入 · 正在出题…</span
                >
                <template v-else-if="practiceProjection(item.recordId)?.state === 'joined'">
                  <span
                    class="rl-status rl-status--got"
                    :data-testid="`mistake-practice-state-${item.recordId}`"
                    >✓ 已加入练习集</span
                  >
                  <button
                    type="button"
                    class="rl-btn"
                    :data-testid="`mistake-practice-view-${item.recordId}`"
                    @click="viewGeneratedPractice(item.recordId)"
                  >
                    查看新题
                  </button>
                </template>
                <button
                  v-else-if="
                    ['available', 'failed', 're_add'].includes(
                      practiceProjection(item.recordId)?.state ?? '',
                    )
                  "
                  type="button"
                  class="rl-btn"
                  :disabled="practiceGenerationBusy.includes(item.recordId)"
                  :data-testid="`mistake-practice-${item.recordId}`"
                  @click="runPracticeGeneration(item)"
                >
                  {{ practiceActionLabel(item.recordId) }}
                </button>
              </template>
              <template #list-row-actions="{ item }">
                <button
                  v-if="item.status === 'archived' && item.fields.restorable === true"
                  type="button"
                  class="rl-btn"
                  :disabled="archiveBusy.includes(item.recordId)"
                  :data-testid="`mistake-restore-${item.recordId}`"
                  @click="restoreArchivedRecord(item)"
                >
                  {{ t('k12.records.restoreReview') }}
                </button>
                <button
                  v-else-if="item.status !== 'archived'"
                  type="button"
                  class="rl-btn"
                  :disabled="archiveBusy.includes(item.recordId)"
                  :data-testid="`mistake-archive-${item.recordId}`"
                  @click="archiveMistake(item)"
                >
                  {{ t('k12.records.archiveReview') }}
                </button>
              </template>
            </RecordList>
          </div>
        </template>
      </section>

      <!-- 练习集：组好的题（真实 /practice-sets）——生命周期 + 发布门 -->
      <section v-else-if="sub === 'practiceSets'" data-testid="practicesets-section">
        <K12PracticeSetsPanel
          :agent-id="props.agentId"
          :focus-target="practiceTarget"
          @count="updatePracticeCount"
        />
      </section>

      <!-- 积累本：语/英沉淀（真实 /accumulation）——记录本原语第二场景 -->
      <section v-else-if="sub === 'accumulation'" class="k12accum" data-testid="accum-prototype">
        <!-- 原型 rc1（app.html:1618）：积累 tab 带 cxsec 标题 + 说明（错题 tab 无标题——顶栏已声明身份；
             积累 / 学情 tab 各有 h2 标题，与学情 tab reporthead 同款）。 -->
        <div class="k12rec__reporthead">
          <h3 class="k12rec__h" style="margin: 0">{{ t('k12.accum.title') }}</h3>
          <span class="k12rec__hint" style="margin: 0">{{ t('k12.accum.desc') }}</span>
          <div class="k12accum__filters" role="group" :aria-label="t('k12.accum.subject')">
            <button
              type="button"
              class="chip"
              :class="{ on: accumSubject === '' }"
              :aria-pressed="accumSubject === ''"
              data-testid="accum-filter-all"
              @click="setAccumSubject('')"
            >
              {{ t('k12.accum.filterAll') }}
            </button>
            <button
              type="button"
              class="chip"
              :class="{ on: accumSubject === '语文' }"
              :aria-pressed="accumSubject === '语文'"
              data-testid="accum-filter-chinese"
              @click="setAccumSubject('语文')"
            >
              {{ t('k12.accum.filterChinese') }}
            </button>
            <button
              type="button"
              class="chip"
              :class="{ on: accumSubject === '英语' }"
              :aria-pressed="accumSubject === '英语'"
              data-testid="accum-filter-english"
              @click="setAccumSubject('英语')"
            >
              {{ t('k12.accum.filterEnglish') }}
            </button>
          </div>
        </div>
        <div
          v-if="accumulationLoading"
          class="k12rec__loading"
          role="status"
          data-testid="accum-loading"
        >
          {{ t('common.loading') }}
        </div>
        <div
          v-else-if="store.accumulationError"
          class="k12rec__err"
          role="alert"
          data-testid="accum-error"
        >
          <span>{{ store.accumulationError }}</span>
          <button class="btn btn-ghost" data-testid="accum-retry" @click="reloadAccum">
            {{ t('common.retry') }}
          </button>
        </div>
        <!-- 当前积累合同：服务端派生学科/类型/来源；列表不投影 mastery/status。 -->
        <div v-else-if="accumView && accumView.items.length" class="k12accum__list">
          <!-- 引文置首；每行 exact-set 为生成默写题主动作 + 查看详情。 -->
          <div
            v-for="item in accumView.items"
            :key="item.recordId"
            class="k12accum__row k12accum__row--quote"
          >
            <b class="k12accum__title" :title="accumField(item, 'content')">{{
              accumField(item, 'content')
            }}</b>
            <span class="k12accum__subject">{{ accumField(item, 'subject') }}</span>
            <span class="k12accum__type">{{ accumField(item, 'entry_type') }}</span>
            <span class="k12accum__source" :title="accumSourceLabel(item)">{{
              accumSourceLabel(item)
            }}</span>
            <span v-if="accumDate(item)" class="k12accum__date" data-testid="accum-date">{{
              accumDate(item)
            }}</span>
            <button
              class="btn"
              :data-testid="`accum-list-dictation-${item.recordId}`"
              :disabled="accumulationDictationDisabled(item)"
              :aria-busy="accumulationDictationPending(item)"
              @click="dictationToBasket(item)"
            >
              {{ accumulationDictationLabel(item) }}
            </button>
            <button
              class="btn btn-ghost k12accum__detail"
              :data-testid="`accum-list-detail-${item.recordId}`"
              @click="openDetail(item, 'accum')"
            >
              {{ t('k12.accum.viewDetails') }}
            </button>
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
        <K12CreativeWorksPanel
          ref="creativeWorksRef"
          :agent-id="props.agentId"
          :show-add-button="false"
          @count="updateWorksCount"
        />
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
          <HcClearableField>
            <textarea
              v-model="mistakeForm.problem"
              class="k12accum__content k12accum__content--area"
              data-testid="mistake-problem"
              rows="3"
              :placeholder="t('k12.mistakeAdd.problemPh')"
              @keydown="onMistakeKeydown"
            />
          </HcClearableField>
          <div class="k12accum__field" data-testid="mistake-subject">
            <span>{{ t('k12.accum.subject') }}</span>
            <HcSelect
              v-model="mistakeForm.subject"
              :options="mistakeSubjectOptions"
              :placeholder="t('k12.tutoringTips.pickHint')"
            />
          </div>
          <HcClearableField>
            <textarea
              v-model="mistakeForm.studentAnswer"
              class="k12accum__content k12accum__content--area"
              data-testid="mistake-answer"
              rows="2"
              :placeholder="t('k12.mistakeAdd.answerPh')"
              @keydown="onMistakeKeydown"
            />
          </HcClearableField>
          <HcClearableField>
            <input
              v-model="mistakeForm.knowledgePoints"
              class="k12accum__content"
              :placeholder="t('k12.mistakeAdd.kpPh')"
            />
          </HcClearableField>
          <div class="k12rec__addhint">{{ t('k12.mistakeAdd.hint') }}</div>
          <div class="k12accum__actions">
            <button class="btn btn-ghost" @click="mistakeAddOpen = false">
              {{ t('k12.accum.cancel') }}
            </button>
            <button
              class="btn btn-primary"
              data-testid="mistake-submit"
              :disabled="!mistakeForm.subject || !mistakeForm.problem.trim() || mistakeSaving"
              @click="submitMistake"
            >
              {{ mistakeSaving ? t('k12.mistakeAdd.submitting') : t('k12.mistakeAdd.submit') }}
            </button>
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
        <!-- 当前创建合同只接受 content；学科、类型、来源均由服务端派生。 -->
        <div class="k12accum__form k12accum__form--modal">
          <HcClearableField>
            <textarea
              v-model="accumForm.content"
              class="k12accum__content"
              data-testid="accum-add-content"
              :placeholder="t('k12.accum.contentPlaceholder')"
              rows="4"
              @input="rotateAccumCreateKey"
            />
          </HcClearableField>
          <div class="k12accum__actions">
            <button class="btn btn-ghost" @click="accumAddOpen = false">
              {{ t('k12.accum.cancel') }}
            </button>
            <button
              class="btn btn-primary"
              data-testid="accum-add-submit"
              :disabled="!accumForm.content.trim() || accumSaving"
              @click="submitAccum"
            >
              {{ t('k12.accum.submit') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 自定义组卷 modal（原型 openCustomPaper=弹窗，同构位置 · BUG-20260709）
         渐进披露：一键零配置仍是主动作，微调参数走此弹窗。 -->
    <div v-if="customPaperOpen" class="k12modal" @click.self="closeCustomPaper">
      <div
        class="k12modal__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-paper-title"
      >
        <div class="k12modal__head">
          <b id="custom-paper-title">{{ t('k12.records.customPaper') }}</b>
          <span class="k12rec__sp" />
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="basketBusy"
            :aria-label="t('k12.customPaper.close')"
            @click="closeCustomPaper"
          >
            ✕
          </button>
        </div>
        <div class="k12accum__form k12accum__form--modal" data-testid="custom-paper-form">
          <div class="k12rec__addhint">{{ t('k12.customPaper.hint') }}</div>
          <!-- 范围（原型 openCustomPaper 四档，UI 先做两档：本周待复习 / 全部未掌握） -->
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.scope') }}</span>
            <button
              v-for="o in paperScopeOpts"
              :key="o.v"
              type="button"
              class="chip"
              :class="{ on: paperForm.scope === o.v }"
              :disabled="basketBusy || !!customPaperResult"
              :aria-pressed="paperForm.scope === o.v"
              :data-testid="`paper-scope-${o.v}`"
              @click="paperForm.scope = o.v"
            >
              {{ o.label }}
            </button>
          </div>
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.perQ') }}</span>
            <button
              v-for="n in paperPerQOpts"
              :key="n"
              type="button"
              class="chip"
              :class="{ on: paperForm.perQ === n }"
              :disabled="basketBusy || !!customPaperResult"
              :aria-pressed="paperForm.perQ === n"
              :data-testid="`paper-perq-${n}`"
              @click="paperForm.perQ = n"
            >
              {{ n }}
            </button>
          </div>
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.difficulty') }}</span>
            <button
              v-for="o in paperDiffOpts"
              :key="o.v"
              type="button"
              class="chip"
              :class="{ on: paperForm.difficulty === o.v }"
              :disabled="basketBusy || !!customPaperResult"
              :aria-pressed="paperForm.difficulty === o.v"
              :data-testid="`paper-difficulty-${o.v}`"
              @click="paperForm.difficulty = o.v"
            >
              {{ o.label }}
            </button>
          </div>
          <div class="k12rec__addhint" data-testid="custom-paper-contract-note">
            {{ t('k12.customPaper.contractNote') }}
          </div>
          <div class="k12paper__row">
            <span class="k12paper__label">{{ t('k12.customPaper.total') }}</span>
            <button
              v-for="o in paperTotalOpts"
              :key="o.v"
              type="button"
              class="chip"
              :class="{ on: paperForm.total === o.v }"
              :disabled="basketBusy || !!customPaperResult"
              :aria-pressed="paperForm.total === o.v"
              @click="paperForm.total = o.v"
            >
              {{ o.label }}
            </button>
          </div>
          <p class="k12rec__addhint" data-testid="custom-paper-boundary">
            {{
              t('k12.customPaper.boundary', {
                textbook: textbookBoundary || t('k12.customPaper.textbookMissing'),
                grade: gradeBoundary || t('k12.customPaper.gradeMissing'),
              })
            }}
          </p>
          <p
            v-if="basketBusy"
            class="k12rec__addhint"
            role="status"
            aria-live="polite"
            data-testid="custom-paper-progress"
          >
            {{ t('k12.customPaper.generating') }}
          </p>
          <div
            v-else-if="customPaperError"
            class="k12rec__error"
            role="alert"
            data-testid="custom-paper-error"
          >
            <span>{{ customPaperError }}</span>
            <button
              type="button"
              class="btn btn-ghost"
              data-testid="custom-paper-retry"
              @click="genCustomPaper"
            >
              {{ t('k12.customPaper.retry') }}
            </button>
          </div>
          <div
            v-else-if="customPaperResult"
            class="k12paper__result"
            role="status"
            aria-live="polite"
            data-testid="custom-paper-result"
          >
            <b>{{ t('k12.customPaper.completed') }}</b>
            <span>{{
              t('k12.customPaper.receipt', {
                id: customPaperResult.generation_job_id,
                added: customPaperResult.added,
                deduplicated: customPaperResult.deduplicated,
              })
            }}</span>
            <span v-if="customPaperResult.added === 0">{{
              t('k12.customPaper.idempotentReplay')
            }}</span>
            <ul v-if="customPaperResult.items.length" class="k12paper__results">
              <li v-for="item in customPaperResult.items" :key="item.item_id">
                <span>{{ t('k12.customPaper.sourceItem', { id: item.source_problem_id }) }}</span>
                <span>{{
                  t('k12.customPaper.actualDifficulty', {
                    value: paperDifficultyLabel(item.actual_difficulty),
                  })
                }}</span>
                <span>{{
                  item.verification_status === 'verified'
                    ? t('k12.customPaper.verified')
                    : t('k12.customPaper.blocked')
                }}</span>
              </li>
            </ul>
          </div>
          <div class="k12accum__actions">
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="basketBusy"
              @click="closeCustomPaper"
            >
              {{ customPaperResult ? t('k12.customPaper.close') : t('k12.accum.cancel') }}
            </button>
            <button
              v-if="customPaperResult"
              type="button"
              class="btn btn-primary"
              data-testid="custom-paper-view-basket"
              @click="viewCustomPaperBasket"
            >
              {{ t('k12.customPaper.viewBasket') }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-primary"
              data-testid="custom-paper-gen"
              :disabled="basketBusy || !textbookBoundary"
              @click="genCustomPaper"
            >
              {{
                basketBusy ? t('k12.customPaper.generatingShort') : t('k12.customPaper.generate')
              }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 错题详情弹层（BUG-20260712-#2）：复用列表已有 RecordItem 字段，不额外请求后端，可关闭。 -->
    <div
      v-if="detail.open && detail.record && !accumulationDeleteConfirmActive"
      class="k12modal"
      data-testid="mistake-detail"
      role="dialog"
      aria-modal="true"
      @click.self="closeDetail"
    >
      <div ref="detailCard" class="k12modal__card">
        <div class="k12modal__head">
          <b>{{ detail.kind === 'accum' ? t('k12.accum.detailTitle') : t('k12.detail.title') }}</b>
          <span
            v-if="detailStatus"
            class="k12detail__status"
            :class="`k12detail__status--${detailStatusTone}`"
            data-testid="detail-status"
            >{{ detailStatus }}</span
          >
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="closeDetail">✕</button>
        </div>
        <!-- 积累本详情：内容 / 学科 / 类型（积累不复习，无错因/再练语义） -->
        <div v-if="detail.kind === 'accum'" class="k12detail">
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.content') }}</span>
            <MarkdownRenderer
              class="k12detail__val k12detail__val--md"
              data-testid="detail-content"
              :content="detailContent || '—'"
            />
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.accum.subject') }}</span>
            <p class="k12detail__val" data-testid="detail-accum-subject">
              {{ detailAccumSubject || '—' }}
            </p>
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.accum.type') }}</span>
            <p class="k12detail__val" data-testid="detail-accum-type">
              {{ detailAccumType || '—' }}
            </p>
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.accumulationFields.source') }}</span>
            <p class="k12detail__val" data-testid="detail-accum-source">
              {{ detailAccumSource || '—' }}
            </p>
          </div>
          <!-- §3.9 检验出口：生成默写题加入练习集（打印回传才进自动复批闭环） -->
          <div class="k12detail__actions">
            <button
              class="btn btn-ghost"
              data-testid="accum-copy-content"
              @click="copyAccumulationContent"
            >
              {{ t('k12.accum.copyContent') }}
            </button>
            <button
              class="btn btn-ghost"
              data-testid="accum-send-phone"
              :disabled="accumulationDelivery.disabled.value"
              @click="sendAccumulationToPhone"
            >
              {{ accumulationDelivery.label.value }}
            </button>
            <button
              class="btn"
              data-testid="accum-dictation-to-basket"
              :disabled="accumulationDictationDisabled(detail.record!)"
              :aria-busy="accumulationDictationPending(detail.record!)"
              @click="dictationToBasket(detail.record)"
            >
              {{ accumulationDictationLabel(detail.record!) }}
            </button>
            <button
              type="button"
              class="hc-btn hc-btn-ghost hc-btn-danger-ghost"
              data-testid="accum-delete"
              @click="askDelete"
            >
              {{ t('k12.accum.delete') }}
            </button>
          </div>
          <p class="k12rec__hint" style="margin-top: 4px">{{ t('k12.accum.dictationHint') }}</p>
        </div>
        <!-- 错题详情：题目 / 知识点 / 错因 -->
        <div v-else class="k12detail">
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.question') }}</span>
            <MarkdownRenderer
              class="k12detail__val k12detail__val--md"
              data-testid="detail-question"
              :content="detailQuestion || '—'"
            />
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.knowledgePoint') }}</span>
            <p class="k12detail__val" data-testid="detail-kp">{{ detailKp || '—' }}</p>
          </div>
          <div class="k12detail__row">
            <span class="k12detail__label">{{ t('k12.detail.errorCause') }}</span>
            <MarkdownRenderer
              class="k12detail__val k12detail__val--md"
              data-testid="detail-error"
              :content="detailError || t('k12.detail.noErrorCause')"
            />
          </div>
          <!-- 抽查复验未过（§3.6 规则 3/4）：事实标注 + 温和话术，不否定家长判断，只补齐证据 -->
          <p
            v-if="detailSpotCheckFailed"
            class="k12detail__spotcheck"
            data-testid="detail-spotcheck-failed"
          >
            {{ t('k12.detail.spotCheckFailed') }} · {{ t('k12.detail.spotCheckFailedHint') }}
          </p>
        </div>
        <p v-if="detail.kind !== 'accum'" class="k12rec__hint">{{ t('k12.detail.footnote') }}</p>
        <!-- UX-1：详情弹层「家长确认已会」（已掌握态改显只读徽标，幂等）。仅错题（积累不复习/无掌握语义）。 -->
        <div v-if="detail.kind !== 'accum'" class="k12detail__actions">
          <button
            v-if="detailRestorable"
            class="btn btn-primary"
            data-testid="detail-restore-review"
            :disabled="archiveBusy.includes(detail.record!.recordId)"
            @click="restoreArchivedRecord(detail.record!)"
          >
            {{ t('k12.records.restoreReview') }}
          </button>
          <button
            v-else-if="!detailArchived && !detailMastered"
            class="btn btn-primary"
            data-testid="detail-mark-mastered"
            @click="markMasteredFromDetail"
          >
            {{ t('records.markMastered') }}
          </button>
          <span
            v-else-if="!detailArchived"
            class="k12detail__status k12detail__status--got"
            data-testid="detail-mastered-label"
            >{{ t('k12.detail.alreadyMastered') }}</span
          >
          <button
            v-if="!detailArchived"
            class="btn btn-ghost"
            data-testid="detail-archive-review"
            :disabled="archiveBusy.includes(detail.record!.recordId)"
            @click="archiveMistake(detail.record!)"
          >
            {{ t('k12.records.archiveReview') }}
          </button>
          <span class="k12rec__sp" />
          <!-- UX-3：克制删除入口——ghost 次级样式（非首屏主按钮），二次确认后才删。 -->
          <button
            class="hc-btn hc-btn-ghost hc-btn-danger-ghost"
            data-testid="detail-delete"
            @click="askDelete"
          >
            {{ t('k12.detail.delete') }}
          </button>
        </div>
        <p v-if="detail.kind !== 'accum'" class="k12detail__delhint">
          {{ t('k12.detail.deleteHint') }}
        </p>
      </div>
    </div>

    <!-- UX-3：删除二次确认（复用平台 ConfirmDialog；副文案说明用途=移除记错/重复条目）。 -->
    <ConfirmDialog
      :open="confirmDelete"
      :title="deleteConfirmTitle"
      :message="deleteConfirmMessage"
      :confirm-text="deleteConfirmText"
      :cancel-text="t('k12.accum.cancel')"
      :danger="true"
      :confirmation-key="deleteConfirmationKey"
      @confirm="doDelete"
      @cancel="cancelDelete"
    />

    <Teleport to="body">
      <div
        v-if="archiveUndo"
        class="k12archive-undos"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        <div :key="`${archiveUndo.agentId}:${archiveUndo.recordId}`" class="k12archive-undo">
          <span>{{ t('k12.records.archivedToast') }}</span>
          <button
            type="button"
            :disabled="archiveBusy.includes(archiveUndo.recordId)"
            :data-testid="`mistake-archive-undo-${archiveUndo.recordId}`"
            @click="undoArchive(archiveUndo)"
          >
            {{ t('k12.records.undoArchive') }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.k12rec {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.k12archive-undos {
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  z-index: var(--hc-z-toast);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.k12archive-undo {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 260px;
  padding: 11px 14px;
  color: var(--hc-text-primary);
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  box-shadow: var(--hc-shadow-lg);
}
.k12archive-undo button {
  margin-inline-start: auto;
  border: 0;
  background: transparent;
  color: var(--hc-accent);
  font-weight: 650;
  cursor: pointer;
}
.k12archive-undo button:disabled {
  opacity: 0.55;
  cursor: default;
}
.k12rec__tabs {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--hc-border);
}
.k12rec__sp {
  flex: 1;
}
.k12rec__body {
  flex: 1;
  overflow: auto;
  padding: 16px 20px 40px;
}
.k12rec__ftue {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.k12rec__ftue-notice {
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  padding: 11px 13px;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  line-height: 1.55;
}
.k12rec__ftue-notice b {
  color: var(--hc-text-primary);
}
.k12rec__ftue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.k12rec__ftue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.k12rec__ftue-row b {
  color: var(--hc-text-primary);
}
.k12rec__ftue-row > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12rec__ftue-row em {
  flex: none;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
  font-style: normal;
}
.k12rec__err {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--hc-error);
  font-size: 13px;
  margin-bottom: 10px;
}
.k12rec__loading {
  margin: 0;
  padding: 18px 2px;
  color: var(--hc-text-muted);
  font-size: 12.5px;
}
.k12rec__review-action {
  position: relative;
  flex: none;
}
.k12rec__split {
  display: inline-flex;
  border-radius: 10px;
  box-shadow: 0 6px 18px rgba(95, 179, 234, 0.28);
  transition:
    transform 0.12s ease-out,
    box-shadow 0.2s ease-out;
}
.k12rec__split:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 26px rgba(95, 179, 234, 0.34);
}
.k12rec__split .btn-primary {
  height: 32px;
  border-radius: 8px 0 0 8px;
  box-shadow: none;
}
.k12rec__split .btn-primary:hover {
  transform: none;
  box-shadow: none;
}
.k12rec__split-caret {
  width: 30px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-left: 0.5px solid rgba(255, 255, 255, 0.3);
  border-radius: 0 8px 8px 0;
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  cursor: pointer;
}
.k12rec__split-caret:hover:not(:disabled) {
  filter: brightness(1.05);
}
.k12rec__split-caret:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.k12rec__export {
  position: relative;
}
.k12rec__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  box-shadow: var(--hc-shadow-md);
  padding: 4px;
  min-width: 120px;
  display: flex;
  flex-direction: column;
}
.k12rec__menu button {
  text-align: left;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 13px;
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
  white-space: nowrap; /* BUG-20260710 ②：「导出 Markdown」曾折成两行 */
}
.k12rec__menu button:hover {
  background: var(--hc-bg-hover);
}
.k12rec__object-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 10px;
}
.k12rec__object-description {
  margin: 0;
  color: var(--hc-text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.k12rec__result-count {
  flex: none;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.k12rec__filter-stack {
  display: grid;
  gap: 9px;
  padding: 12px 14px;
  margin: 0 0 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 14px;
  background: var(--hc-bg-card);
}
.k12rec__filter-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.k12rec__filter-label {
  width: 38px;
  flex: none;
  color: var(--hc-text-muted);
  font-size: 10.5px;
  font-weight: 700;
}
.k12rec__filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 0.5px solid var(--hc-border);
  border-radius: 9px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.k12rec__filter-row--subject .k12rec__filter {
  width: 68px;
  justify-content: center;
  flex: none;
  white-space: nowrap;
}
.k12rec__filter.on {
  color: var(--hc-accent);
  border-color: color-mix(in srgb, var(--hc-accent) 35%, var(--hc-border));
  background: var(--hc-accent-subtle);
}
.k12rec__archive-note {
  margin: 0 0 8px;
  line-height: 1.6;
}
.k12rec__hint {
  font-size: 11.5px;
  color: var(--hc-text-muted);
  margin-top: 12px;
}
.k12rec__insightlink {
  color: var(--hc-accent);
  cursor: pointer;
}
.k12rec__insightlink:hover {
  text-decoration: underline;
}
.k12rec__alert {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: var(--hc-radius-md);
  border-left: 3px solid var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 8%, transparent);
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}
.k12rec__sugg {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}
.k12rec__h {
  font-size: 13px;
  font-weight: 600;
  margin: 18px 0 4px;
}
.k12rec__reporthead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.k12accum__filters {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.k12rec__tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
} /* M1：原型 mini-grid 4 块 */
.k12tile {
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  padding: 12px 14px;
  font-size: 12px;
  color: var(--hc-text-secondary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.k12tile b {
  font-size: 18px;
  color: var(--hc-text-primary);
}
.k12bars {
  max-width: 520px;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.k12bar {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
}
.k12bar__label {
  width: 100px;
  flex-shrink: 0;
  color: var(--hc-text-secondary);
}
.k12bar__rail {
  flex: 1;
  height: 9px;
  background: var(--hc-bg-input);
  border-radius: 99px;
  overflow: hidden;
}
.k12bar__fill {
  display: block;
  height: 100%;
  background: var(--hc-accent);
  border-radius: 99px;
}
.k12bar b {
  width: 26px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
/* 积累本分科过滤 + 手动记录 */
.k12accum__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.k12accum__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.k12accum__subject {
  flex: none;
  padding: 1px 7px;
  border-radius: 6px;
  font-size: 11px;
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}
.k12accum__title {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--hc-text-primary);
}
.k12accum__type {
  flex: none;
  padding: 2px 7px;
  border-radius: 4px;
  white-space: nowrap;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 10.5px;
  font-weight: 650;
}
.k12accum__source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12accum__detail {
  flex: none;
}
/* 20260718 原型定案（引文列表）：引文衬线置首 + 引号压角，量度 62ch；meta 行随 flex-wrap 落第二行 */
.k12accum__row--quote {
  flex-wrap: wrap;
  align-content: flex-start;
  row-gap: 8px;
  padding: 14px 16px 12px;
  border-radius: 16px;
  box-shadow: var(--hc-shadow-sm);
}
.k12accum__row--quote .k12accum__title {
  flex: 1 1 100%;
  max-width: 62ch;
  order: -1;
  white-space: normal;
  overflow: visible;
  font-family: 'Songti SC', ui-serif, STSong, serif;
  font-size: 14.5px;
  line-height: 1.65;
  font-weight: 600;
  position: relative;
  padding-left: 26px;
}
.k12accum__row--quote .k12accum__title::before {
  content: '\201C';
  position: absolute;
  left: 0;
  top: -4px;
  font-size: 27px;
  line-height: 1;
  font-family: Georgia, ui-serif, serif;
  color: var(--hc-accent);
  opacity: 0.55;
}
.k12accum__date {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  font-size: 12px;
}
.chip {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
}
.chip.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  border-color: var(--hc-border-hl);
  font-weight: 600;
}
.k12accum__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  padding: 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-elevated);
}
.k12accum__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  min-width: 130px;
  flex: 1;
}
.k12accum__field > span {
  font-size: 12.5px;
}
.k12accum__content {
  width: 100%;
  box-sizing: border-box;
  font-size: 13px;
  padding: 8px 10px;
  resize: vertical;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
/* 多行捕获字段（20260712：题目/错处适配长内容——应用题/古诗/整句整段粘贴） */
.k12accum__content--area {
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  min-height: 44px;
  resize: vertical;
}
.k12accum__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* 积累空态：克制列表占位（原型 rc1 无大居中卡；入口在上方 bar 常驻） */
.k12accum__empty {
  color: var(--hc-text-muted);
  font-size: 13px;
  padding: 22px 4px;
  text-align: center;
  margin: 0;
}
/* modal 内的表单去掉自带卡片边框（弹层卡片已提供容器） */
.k12accum__form--modal {
  border: none;
  background: transparent;
  padding: 0;
  margin-bottom: 0;
}
/* 记一条错题 / 自定义组卷弹窗（平台标准 modal 形态） */
.k12modal {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.32);
  padding: 24px;
}
.k12modal__card {
  width: min(520px, 100%);
  max-height: 80vh;
  overflow: auto;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-lg);
  box-shadow: var(--hc-shadow-lg);
  padding: 16px 18px;
}
.k12modal__head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
  font-size: 13.5px;
}
/* 手工录入错题 / 自定义组卷 */
.k12rec__addhint {
  font-size: 11.5px;
  color: var(--hc-text-muted);
  line-height: 1.5;
}
.k12paper__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.k12paper__label {
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  width: 92px;
  flex-shrink: 0;
}
.k12rec__error,
.k12paper__result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  border-radius: var(--hc-radius-md);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
}
.k12rec__error {
  color: var(--hc-danger);
  background: color-mix(in srgb, var(--hc-danger) 8%, transparent);
}
.k12paper__result {
  color: var(--hc-text-secondary);
  background: var(--hc-accent-subtle);
}
.k12paper__result > b {
  color: var(--hc-success);
  font-size: 13px;
}
.k12paper__results {
  width: 100%;
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.k12paper__results li {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 5px;
  border-top: 0.5px solid var(--hc-border);
}
/* seg / pill / btn 复用全局 global.css 令牌类 */
.seg {
  position: relative;
  display: inline-flex;
  background: var(--hc-bg-input);
  border: 1px solid var(--hc-border);
  border-radius: 11px;
  padding: 3px;
  gap: 2px;
}
.seg button {
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
}
.seg button.on {
  background: var(--hc-bg-elevated);
  color: var(--hc-accent);
  box-shadow: var(--hc-shadow-sm);
  font-weight: 600;
}
/* 原型 1172-1177：二级对象 Tab 没有 segmented 底板；选中态仅强调色轻底，不做白卡浮起。 */
.k12rec__object-tabs {
  gap: 3px;
  overflow-x: auto;
  max-width: 100%;
  flex: 1 1 auto;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
}
.k12rec__object-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  padding: 7px 12px;
  border-radius: 9px;
  color: var(--hc-text-secondary);
}
.k12rec__object-tabs button:hover:not(.on) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12rec__object-tabs button.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  box-shadow: none;
  font-weight: 600;
}
.k12-tab-count {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 999px;
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
  font-size: 10px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}
.k12-tab-count::before {
  content: attr(data-count);
}
.k12rec__object-tabs button.on .k12-tab-count {
  background: color-mix(in srgb, var(--hc-accent) 15%, transparent);
  color: var(--hc-accent);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 7px;
}
.pill-green {
  background: rgba(50, 213, 131, 0.14);
  color: var(--hc-success);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
.btn:hover {
  background: var(--hc-bg-hover);
}
.btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--hc-text-secondary);
}
.btn-primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  border-color: transparent;
}
/* BUG-20260709：必须配对 hover——否则 .btn:hover(0,2,0) 压过 .btn-primary(0,1,0) 的渐变，
   浅色主题下 hover = 近白底 + color:#fff 白字看不见。渐变对齐原型 app.html:158（更亮一档）。 */
.btn-primary:hover {
  background: linear-gradient(180deg, #67b8ec 0%, #4f9fe1 100%);
}
/* 功能位单色描边图标（20260709 视觉评审：emoji 只留身份/语义徽章位；与原型 .ic-sm 同规格） */
.k12ic {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.k12rec__addbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
/* 全部错题=默认折叠的次级档案（原型 1598 <details>）：折叠态隐藏筛选 + 档案行（.record-list 直接子 .rl-rows），
   「本周复习」的 .rl-review .rl-rows 是嵌套子、不受 > 直接子选择器命中，故行动卡常驻。 */
.k12arch__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  font-size: 13px;
  font-weight: 700;
  color: var(--hc-text-primary);
  cursor: pointer;
}
.k12arch__caret {
  font-size: 10px;
  color: var(--hc-text-muted);
  transition: transform 0.15s ease;
}
.k12arch__caret--open {
  transform: rotate(90deg);
}
.k12mistakes--collapsed :deep(.rl-filters),
.k12mistakes--collapsed :deep(.rl-empty),
.k12mistakes--collapsed :deep(.record-list > .rl-rows) {
  display: none;
}
/* 原型 1193-1212：本周复习用大数字 hero；列表、自动化脚注都收进同一张卡。 */
:deep(.k12week__hero) {
  border: 0.5px solid var(--hc-border);
  border-left: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: linear-gradient(160deg, var(--hc-accent-subtle), var(--hc-bg-card) 55%);
  box-shadow: var(--hc-shadow-sm);
  padding: 18px 18px 13px;
  margin: 2px 0 14px;
}
:deep(.k12week__hero .rl-review__head) {
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.k12week__count {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.k12week__count b {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}
.k12week__count span {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-secondary);
}
.k12week__meta {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  flex: 1;
}
.k12week__subject {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 10.5px;
  font-weight: 650;
  white-space: nowrap;
}
:deep(.k12week__hero .rl-review__head > .rl-spacer) {
  display: none;
}
:deep(.k12week__hero .rl-rows) {
  margin-top: 0;
}
:deep(.k12week__hero .rl-row) {
  padding: 10px 12px;
}
:deep(.k12week__hero .rl-row > .rl-title) {
  flex: 0 0 250px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.k12week__hero .rl-row > .rl-btn) {
  height: 28px;
  padding: 0 9px;
  border-radius: 8px;
  font-size: 12px;
}
:deep(.k12week__hero .rl-review__foot) {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 0.5px solid var(--hc-divider);
}
/* 「本周复习」趋势 pill（原型 stpill got/done 同源色） */
.k12trend {
  font-size: 10.5px;
  border-radius: 999px;
  padding: 2px 9px;
  font-weight: 700;
  white-space: nowrap;
}
.k12trend--up {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}
.k12trend--flat {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
}
/* 学科定色（原型 .kpill.chi/.eng 同源）：错题列表最高频扫读维度=哪科错得多。
   RecordList 保持领域无关，经 data-chip 前缀选择器由本场景层上色（chip 文案「学科·知识点」）。 */
:deep(.rl-chip[data-chip^='语文']) {
  background: color-mix(in srgb, #e8590c 12%, transparent);
  color: #e8590c;
}
:deep(.rl-chip[data-chip^='英语']) {
  background: color-mix(in srgb, #7048e8 10%, transparent);
  color: #7048e8;
}
/* 错题一键加入练习集的服务端状态投影；与通用 RecordList 状态 pill 同口径。 */
.rl-status {
  font-size: 10.5px;
  border-radius: 999px;
  padding: 2px 9px;
  font-weight: 700;
  white-space: nowrap;
}
.rl-status--todo {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
}
.rl-status--got {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}
/* 错题详情弹层（BUG-20260712-#2）：字段行 label + 值 */
.k12detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 4px 0 6px;
}
.k12detail__row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.k12detail__label {
  font-size: 11.5px;
  color: var(--hc-text-muted);
}
.k12detail__val {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--hc-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
/* md 渲染变体:块级元素自带间距，取消 pre-wrap 避免多余空白（纯文本字段仍用基类的 pre-wrap）。 */
.k12detail__val--md {
  white-space: normal;
}
.k12detail__status {
  font-size: 10.5px;
  border-radius: 999px;
  padding: 2px 9px;
  font-weight: 700;
  white-space: nowrap;
}
.k12detail__status--todo {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}
.k12detail__status--done {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
}
.k12detail__status--got {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}
.k12detail__status--na {
  color: var(--hc-text-muted);
  background: var(--hc-bg-input);
}
.k12detail__spotcheck {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 8%, transparent);
  border-radius: var(--hc-radius-md);
  padding: 7px 10px;
}
/* UX-1/3：详情弹层动作行；危险删除视觉由全局 hc-btn-danger-ghost 统一治理。 */
.k12detail__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.k12detail__delhint {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 6px;
}
/* 项-5：正向空态卡（与「本周复习」行动卡等视觉重量，填住空白，不留悬空） */
.k12empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 26px 18px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
}
.k12empty__icon {
  font-size: 30px;
  line-height: 1;
  margin-bottom: 2px;
}
.k12empty__title {
  font-size: 14.5px;
  color: var(--hc-text-primary);
}
.k12empty__sub {
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  margin: 0;
}
.k12empty__next {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}
.k12empty__cta {
  margin-top: 10px;
}
</style>
