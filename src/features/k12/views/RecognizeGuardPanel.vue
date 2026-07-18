<script setup lang="ts">
/**
 * 拍照识题回显护栏面板（#1 · 原型 app.html #chatTutorView 的信任链上游兜底，PRD §3.2.5）。
 *
 * 流程（2026-07-18 桌面入口迁移到统一 GradingJob，§6.7/§6.15）：作业图片 base64 →
 * store.recognizePhotoJob 创建 Job（后端异步识别+锚点并行增强）→ 轮询到确认停点回显分题 →
 * **家长核对回显「我读到的是…对吗？」✓读对/✏️读错**（OCR 低置信度必核对）→ 逐题填孩子作答 →
 * 「批改整张作业」= store.gradePhotoJob 确认修正 + 轮询到 completed 取逐题结果；
 * 单题补批/空白题求解仍走直连 store.grade / store.solve（保留的单点能力）。
 * 无年级时（冷启动首拍）据识出的知识点倒查课标推断年级建档（#3，store.coldStart）。
 *
 * 本层只做识题回显 + 批改触发；题干正误由家长核对护栏兜底，答案对错由后端 solve 验算链裁决，不造答案。
 */
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useK12Store } from '../store'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'
import HcSelect from '@/components/common/HcSelect.vue'
import VerifyBadge from '@/shell/chat/VerifyBadge.vue'
import PrepCardPanel from './PrepCardPanel.vue'
import PhotoGradeOverlay from './PhotoGradeOverlay.vue'
import { extractBriefFinalAnswer } from '../graded-photo'
import { gradeToResult, gradeToVerify } from '../mappers'
import type { AnswerState, RecognizedQuestion, BBox, PhotoJobResult } from '@/api/k12'
import type { VerifyResult } from '@/contracts'

// 审计单-High-2（bug-20260709）：本组件全部 API 调用的 agent = agents.name（后端隔离键），
// 故 prop 名就叫 agentId——曾命名 agentName 导致上游把 display_name 传进来，写错孩子作用域。
// initialImage（BUG-20260709 拍照发题不解题）：composer 粘贴/上传改道进来的图片 dataURL，
// 传入即预填并自动识题（原型契约「粘贴作业照片即自动 OCR 回显护栏」），家长零多余点击。
const props = defineProps<{ agentId: string; grade?: string; initialImage?: string }>()
// close：面板自动打开（图片改道）后由头部 ✕ 收起——手动 toggle 已删（BUG-20260711-E），
// 收起手段必须内聚在面板自身。
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const store = useK12Store()

/** 一道识出的题在护栏里的可编辑本地状态 */
interface GuardRow {
  problem: string // 家长可就地订正的题干（初值=识别原文）
  knowledgePoints: string[]
  editing: boolean
  studentAnswer: string
  answerState: AnswerState
  grading: boolean
  solving: boolean
  verify: VerifyResult | null
  recorded: boolean
  recordDeduplicated: boolean
  solution: string
  wrongStep: string
  errorCause: string
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
// BUG-20260712：选了文件/贴了图片 data URL 时显示缩略图预览，不再把 base64 原文糊在框里（UX 糙）。
const isImageData = computed(() => imageB64.value.trim().startsWith('data:image'))
const rows = ref<GuardRow[]>([])
const recognizing = ref(false)
const anchoring = ref(false)
const anchorWarning = ref('')
const errMsg = ref('')
const confirmed = ref(false)
const selectedSubject = ref('')
const batchWorking = ref(false)
// 当前照片对应的统一 GradingJob（§6.7）：识题产物与整卷批改都挂在它上面。
const currentJobId = ref('')
let agentGeneration = 0
let recognitionGeneration = 0
const subjectOptions = computed(() =>
  K12_GRADE_SUBJECT_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  })),
)

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
      question: r.problem,
      // solution 可能是整段 Markdown 推导；原图上只显示简短最终答案。
      correctAnswer: extractBriefFinalAnswer(r.solution),
      errorCause: r.errorCause,
    })),
)
// 仅在有作业原图（data URL）且至少一题已批改时展示叠加图。
const showOverlay = computed(() => isImageData.value && overlayMarks.value.length > 0)
const answerPendingIndexes = computed(() =>
  rows.value
    .map((row, i) => ({ row, i }))
    .filter(
      ({ row }) =>
        row.problem.trim() &&
        row.answerState === 'present' &&
        row.studentAnswer.trim() &&
        !row.graded,
    )
    .map(({ i }) => i),
)
const blankPendingIndexes = computed(() =>
  rows.value
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row.problem.trim() && row.answerState === 'blank' && !row.solution)
    .map(({ i }) => i),
)
const unclearAnswerCount = computed(
  () => rows.value.filter((row) => row.problem.trim() && row.answerState === 'unclear').length,
)

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
    imageB64.value = ''
    rows.value = []
    recognizing.value = false
    anchoring.value = false
    anchorWarning.value = ''
    errMsg.value = ''
    confirmed.value = false
    batchWorking.value = false
    selectedSubject.value = ''
    currentJobId.value = ''
    coldStarting.value = false
    coldStartResult.value = null
  },
)

// composer 改道图片：预填 + 自动识题（家长粘贴/上传即进护栏，无需再点「识题」）
watch(
  () => props.initialImage,
  (img) => {
    if (!img || !img.trim()) return
    imageB64.value = img
    void run()
  },
  { immediate: true },
)

async function run() {
  if (!imageB64.value.trim() || recognizing.value) return
  const generation = agentGeneration
  const recognition = ++recognitionGeneration
  const sourceImage = imageB64.value.trim()
  recognizing.value = true
  anchoring.value = false
  anchorWarning.value = ''
  errMsg.value = ''
  confirmed.value = false
  coldStartResult.value = null
  currentJobId.value = ''
  try {
    // 桌面入口迁移（§6.7/§6.15）：识题编排改走统一 GradingJob——创建 Job 后后端异步推进
    // （识别 + 锚点并行增强），前端轮询到确认停点取识别产物回显；护栏交互不变。
    // 识别失败可重试：同图重跑幂等命中失败 Job 并自动走 retry 端点（store 内实现）。
    const job = await store.recognizePhotoJob(props.agentId, sourceImage)
    if (generation !== agentGeneration || recognition !== recognitionGeneration) return
    currentJobId.value = job.jobId
    // Polish-2：识题自动判定整卷学科 → 预填学科下拉，家长不必手选（仍可手动覆盖）。
    // 仅识题判出学科时预填；一科都判不出则保持空，此时 solve/批改按钮仍 gate 空学科需家长手选。
    if (job.subject) selectedSubject.value = job.subject
    // 锚点是并行增强分支：degraded = 无可信坐标 → 界面按既有文字降级口径提示（§4.9）。
    if (job.anchorState === 'degraded') anchorWarning.value = t('k12.recognize.anchorFailed')
    rows.value = job.questions.map((question: RecognizedQuestion) => {
      const answerState = normalizeAnswerState(question)
      return {
        problem: question.question,
        knowledgePoints: question.knowledge_points ?? [],
        editing: false,
        // 预填识题回收的孩子作答；blank/present/unclear 由 answer_state 明确分叉。
        studentAnswer: question.student_answer ?? '',
        answerState,
        grading: false,
        solving: false,
        verify: null,
        recorded: false,
        recordDeduplicated: false,
        solution: '',
        wrongStep: '',
        errorCause: '',
        // 锚点 bbox 已随 Job 停点产物返回（无需独立 anchors 请求）。
        bbox: question.bbox ?? null,
        graded: false,
        verdict: '',
        expanded: false,
      }
    })
  } catch (e) {
    if (generation !== agentGeneration) return
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (generation === agentGeneration) recognizing.value = false
  }
}

function syncAnswerState(row: GuardRow) {
  if (row.studentAnswer.trim()) {
    row.answerState = 'present'
  } else if (row.answerState !== 'blank') {
    // 清空一处已检测到的书写，不代表纸面变成空白；要求家长确认，避免误走自动求解。
    row.answerState = 'unclear'
  }
}

function toggleEdit(row: GuardRow) {
  row.editing = !row.editing
  confirmed.value = false
}

function confirmAll() {
  if (!rows.value.length || rows.value.some((row) => !row.problem.trim())) return
  for (const row of rows.value) row.editing = false
  confirmed.value = true
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

// 命名避开 props.grade（vue/no-dupe-keys：script 顶层标识符与 prop 同名会在模板里撞键）
async function gradeRow(i: number) {
  const row = rows.value[i]
  if (
    !row ||
    !row.problem.trim() ||
    row.answerState !== 'present' ||
    !row.studentAnswer.trim() ||
    row.grading
  )
    return
  row.grading = true
  errMsg.value = ''
  try {
    const res = await store.grade({
      agent: props.agentId,
      subject: selectedSubject.value,
      grade: props.grade ?? '',
      problem: row.problem.trim(),
      student_answer: row.studentAnswer.trim() || undefined,
      knowledge_points: row.knowledgePoints,
    })
    row.verify = res.verify
    row.recorded = res.recordCreated
    row.recordDeduplicated = res.recordDeduplicated
    row.solution = res.solution
    row.wrongStep = res.wrongStep ?? ''
    row.errorCause = res.errorCause ?? ''
    // 已答卷路径：标记为已批改并记录判定（五值口径），供原图叠加画 ✓/✗（bbox 缺失时降级文字批改）。
    row.graded = true
    row.verdict = res.verdict
    // INV-007：新批改结论回填即回到默认折叠态（agree 折叠、其余展开由 isDetailsCollapsed 判定）。
    row.expanded = false
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    row.grading = false
  }
}

// 空白/未作答题「求解·怎么讲」：走 /solve 端点（不要求填答案），给完整解法与验算徽章，
// 不批改、不入错题本。单一真相源分叉的前端落地——空白题不再被迫填答案或触发批改 502。
async function solveRow(i: number) {
  const row = rows.value[i]
  if (!row || !row.problem.trim() || row.answerState !== 'blank' || row.solving || row.grading)
    return
  row.solving = true
  errMsg.value = ''
  try {
    const res = await store.solve({
      agent: props.agentId,
      subject: selectedSubject.value,
      grade: props.grade ?? '',
      problem: row.problem.trim(),
      knowledge_points: row.knowledgePoints,
    })
    row.verify = res.verify
    row.solution = res.solution
    // 解题分叉：无批改结论、不入库、不参与原图叠加（叠加只标已批改的已答题）。
    row.wrongStep = ''
    row.errorCause = ''
    row.recorded = false
    row.recordDeduplicated = false
    row.graded = false
    row.verdict = ''
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    row.solving = false
  }
}

onBeforeUnmount(() => {
  recognitionGeneration += 1
})

// 云端真实模型连续整卷压测证实 3 路会触发上游 429；2 路在速度与稳定性间取平衡，
// 同时避免无界 Promise.all。客户端为每题保留 240s，不能再靠缩短超时假装结束。
async function runBounded(
  indexes: number[],
  worker: (i: number) => Promise<void>,
  concurrency = 2,
) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, indexes.length) }, async () => {
    while (cursor < indexes.length) {
      const index = indexes[cursor++]!
      await worker(index)
    }
  })
  await Promise.all(runners)
}

async function gradeAllAnswered() {
  if (batchWorking.value || !selectedSubject.value || !answerPendingIndexes.value.length) return
  batchWorking.value = true
  errMsg.value = ''
  try {
    if (currentJobId.value) {
      await gradeWholeSheetViaJob()
    } else {
      // 无在途 Job（旧数据/降级态）：保留逐题直连批改兜底。
      await runBounded([...answerPendingIndexes.value], gradeRow)
    }
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    batchWorking.value = false
  }
}

/** Job 化整卷批改（§6.7 公共命令③）：确认冻结（含家长修正）→ 后端异步整卷批改 → 逐题结果回填。 */
async function gradeWholeSheetViaJob() {
  const generation = agentGeneration
  const jobId = currentJobId.value
  const corrections = rows.value.map((row, index) => ({
    index,
    question: row.problem.trim(),
    student_answer: row.studentAnswer.trim(),
    answer_state: row.answerState,
    subject: selectedSubject.value || undefined,
  }))
  try {
    const result = await store.gradePhotoJob(props.agentId, jobId, {
      subject: selectedSubject.value,
      grade: props.grade ?? '',
      corrections,
    })
    if (generation !== agentGeneration) return
    applyPhotoJobResult(result)
  } catch (e) {
    if (generation !== agentGeneration) return
    // Job 已确认/已完成（如批改后补答重批）→ 确认命令 409：回退逐题直连补批，UI 行为不变。
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('409') || msg.includes('不可确认')) {
      await runBounded([...answerPendingIndexes.value], gradeRow)
      return
    }
    throw e
  }
}

/** Job completed 的逐题结果 → 护栏行状态（PhotoGradeOverlay 数据源对齐）。 */
function applyPhotoJobResult(result: PhotoJobResult) {
  result.items.forEach((item, index) => {
    const row = rows.value[index]
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

async function solveAllBlank() {
  if (batchWorking.value || !selectedSubject.value || !blankPendingIndexes.value.length) return
  batchWorking.value = true
  errMsg.value = ''
  const indexes = [...blankPendingIndexes.value]
  try {
    await runBounded(indexes, solveRow)
  } finally {
    batchWorking.value = false
  }
}

async function coldStart() {
  if (!canColdStart.value || coldStarting.value) return
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
  <div class="rec-panel" data-testid="recognize-guard">
    <div class="rec-panel__head">
      <span class="rec-panel__title">📷 {{ t('k12.recognize.title') }}</span>
      <button
        class="rec-panel__x"
        data-testid="recognize-close"
        :aria-label="t('common.close', '关闭')"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>
    <p class="rec-panel__intro">{{ t('k12.recognize.intro') }}</p>

    <!-- 图片输入：文件选择 + base64 粘贴回退 -->
    <label class="rec-panel__file">
      <input type="file" accept="image/*" data-testid="recognize-file" @change="onFile" />
      <span>{{ t('k12.recognize.pickImage') }}</span>
    </label>
    <!-- 选了图片 → 显示缩略图预览（不糊 base64 原文）；textarea 用 v-show 保留在 DOM 供粘贴回退。 -->
    <img
      v-if="isImageData"
      :src="imageB64"
      class="rec-panel__preview"
      data-testid="recognize-preview"
      alt="作业照片预览"
    />
    <textarea
      v-show="!isImageData"
      v-model="imageB64"
      class="rec-panel__b64"
      data-testid="recognize-b64"
      :placeholder="t('k12.recognize.pasteHint')"
      rows="2"
    />

    <button
      class="rec-panel__run"
      data-testid="recognize-run"
      :disabled="!imageB64.trim() || recognizing"
      @click="run"
    >
      {{ recognizing ? t('k12.recognize.running') : t('k12.recognize.run') }}
    </button>

    <div v-if="errMsg" class="rec-panel__err">{{ t('k12.recognize.err') }}：{{ errMsg }}</div>
    <div
      v-if="anchoring || anchorWarning"
      class="rec-panel__anchor-status"
      :class="{ 'is-warning': !!anchorWarning }"
      data-testid="recognize-anchor-status"
    >
      {{ anchorWarning || t('k12.recognize.anchoring') }}
    </div>

    <div class="rec-panel__subject" data-testid="recognize-subject">
      <span>{{ t('k12.accum.subject') }}</span>
      <HcSelect
        v-model="selectedSubject"
        :options="subjectOptions"
        :placeholder="t('k12.prep.pickHint')"
      />
    </div>

    <!-- 冷启动倒查建档入口（#3，仅无年级 + 已识题时） -->
    <div v-if="canColdStart" class="rec-cold">
      <span class="rec-cold__hint">{{ t('k12.recognize.coldStartHint') }}</span>
      <button
        class="rec-cold__btn"
        data-testid="coldstart-infer"
        :disabled="coldStarting"
        @click="coldStart"
      >
        {{
          coldStarting ? t('k12.recognize.coldStartInferring') : t('k12.recognize.coldStartInfer')
        }}
      </button>
    </div>
    <div v-if="coldStartResult" class="rec-cold rec-cold--done" data-testid="coldstart-result">
      {{
        coldStartResult.inferred
          ? t('k12.recognize.coldStartInferred', { grade: coldStartResult.grade })
          : t('k12.recognize.coldStartFallback', { grade: coldStartResult.grade })
      }}
    </div>

    <!-- 识题回显护栏：逐题核对 -->
    <div v-if="rows.length" class="rec-guard">
      <div class="rec-guard__title">🔍 {{ t('k12.recognize.guardTitle') }}</div>
      <div v-for="(row, i) in rows" :key="i" class="rec-row" data-testid="rq-item">
        <div class="rec-row__q">
          <input
            v-if="row.editing"
            v-model="row.problem"
            class="rec-row__edit"
            :data-testid="`rq-problem-${i}`"
            :placeholder="t('k12.recognize.problemPlaceholder')"
          />
          <span v-else class="rec-row__qtext">{{ row.problem }}</span>
          <button class="rec-row__toggle" :data-testid="`rq-edit-${i}`" @click="toggleEdit(row)">
            {{ row.editing ? t('k12.recognize.readOk') : t('k12.recognize.readWrong') }}
          </button>
        </div>
        <div v-if="row.knowledgePoints.length" class="rec-row__kp">
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
          <span class="rec-row__correct-line">{{ i + 1 }}. ✓ {{ truncateProblem(row.problem) }}</span>
          <span class="rec-row__correct-toggle">{{
            row.expanded ? t('k12.recognize.correctCollapse') : t('k12.recognize.correctExpand')
          }}</span>
        </button>
        <div
          v-if="row.verify && (row.solution || row.wrongStep || row.errorCause) && !isDetailsCollapsed(row)"
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

        <div v-if="confirmed" class="rec-row__grade">
          <input
            v-model="row.studentAnswer"
            class="rec-row__answer"
            :data-testid="`rq-answer-${i}`"
            :placeholder="t('k12.recognize.answerPlaceholder')"
            @input="syncAnswerState(row)"
          />
          <!-- 空白题：走「求解·怎么讲」（不要求填答案）；已答题：批改按钮亮起。 -->
          <button
            class="rec-row__solvebtn"
            :data-testid="`rq-solve-${i}`"
            :disabled="
              batchWorking ||
              !row.problem.trim() ||
              !selectedSubject ||
              row.answerState !== 'blank' ||
              row.solving ||
              row.grading
            "
            @click="solveRow(i)"
          >
            {{ row.solving ? t('k12.recognize.solving') : t('k12.recognize.solve') }}
          </button>
          <button
            class="rec-row__gradebtn"
            :data-testid="`rq-grade-${i}`"
            :disabled="
              batchWorking ||
              !row.problem.trim() ||
              !selectedSubject ||
              !row.studentAnswer.trim() ||
              row.grading ||
              row.solving
            "
            @click="gradeRow(i)"
          >
            {{ row.grading ? t('k12.recognize.grading') : t('k12.recognize.grade') }}
          </button>
        </div>
        <p
          v-if="confirmed && row.answerState === 'unclear'"
          class="rec-row__unclearhint"
          :data-testid="`rq-unclear-hint-${i}`"
        >
          {{ t('k12.recognize.unclearAnswerHint') }}
        </p>
        <p
          v-else-if="confirmed && row.answerState === 'blank'"
          class="rec-row__blankhint"
          :data-testid="`rq-blank-hint-${i}`"
        >
          {{ t('k12.recognize.blankHint') }}
        </p>
      </div>
      <button
        v-if="!confirmed"
        class="rec-guard__confirm"
        data-testid="recognize-confirm-all"
        :disabled="rows.some((row) => !row.problem.trim())"
        @click="confirmAll"
      >
        {{ t('k12.recognize.confirmAll') }}
      </button>
      <div v-else class="rec-guard__batch" data-testid="recognize-batch-actions">
        <span
          v-if="unclearAnswerCount"
          class="rec-guard__unclear"
          data-testid="recognize-unclear-count"
        >
          {{ t('k12.recognize.unclearAnswerCount', { count: unclearAnswerCount }) }}
        </span>
        <button
          v-if="answerPendingIndexes.length"
          class="rec-guard__batchbtn rec-guard__batchbtn--primary"
          data-testid="recognize-grade-all"
          :disabled="batchWorking || !selectedSubject"
          @click="gradeAllAnswered"
        >
          {{
            batchWorking
              ? t('k12.recognize.batchWorking')
              : t('k12.recognize.gradeAll', { count: answerPendingIndexes.length })
          }}
        </button>
        <button
          v-if="blankPendingIndexes.length"
          class="rec-guard__batchbtn"
          data-testid="recognize-solve-all"
          :disabled="batchWorking || !selectedSubject"
          @click="solveAllBlank"
        >
          {{
            batchWorking
              ? t('k12.recognize.batchWorking')
              : t('k12.recognize.solveAll', { count: blankPendingIndexes.length })
          }}
        </button>
      </div>
    </div>
    <p v-else-if="!recognizing" class="rec-panel__empty">{{ t('k12.recognize.empty') }}</p>

    <!-- 原图批改叠加（Phase 1）：已批改题在作业原图上确定性画 ✓/✗（bbox 缺失/非法则降级文字批改）。 -->
    <PhotoGradeOverlay v-if="showOverlay" :image="imageB64" :marks="overlayMarks" />

    <!-- 整体确认后才内联辅导要点：避免 OCR 尚未核对就把误识知识点送入备课链。 -->
    <PrepCardPanel
      v-if="confirmed && rows.length && allKnowledgePoints.length"
      :agent-id="agentId"
      :grade="props.grade || ''"
      :knowledge-points="allKnowledgePoints"
    />
  </div>
</template>

<style scoped>
.rec-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}
.rec-panel__head {
  display: flex;
  align-items: center;
}
.rec-panel__title {
  font-size: 13px;
  font-weight: 700;
  flex: 1;
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
.rec-panel__anchor-status {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}
.rec-panel__anchor-status.is-warning {
  color: var(--hc-warn, #b7791f);
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
.rec-guard__title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--hc-text-primary);
}
.rec-guard__confirm {
  align-self: flex-end;
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
.rec-guard__batch {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.rec-guard__unclear {
  flex: 1 1 100%;
  font-size: 11.5px;
  color: var(--hc-warn, #b7791f);
  text-align: end;
}
.rec-guard__batchbtn {
  font-size: 12px;
  padding: 7px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  cursor: pointer;
}
.rec-guard__batchbtn--primary {
  border-color: var(--hc-border-hl);
  background: var(--hc-accent);
  color: white;
}
.rec-guard__batchbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
.rec-row__grade {
  display: flex;
  gap: 6px;
}
.rec-row__answer {
  flex: 1;
  font-size: 12.5px;
  padding: 6px 8px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
.rec-row__gradebtn {
  font-size: 12px;
  padding: 6px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.rec-row__gradebtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rec-row__solvebtn {
  font-size: 12px;
  padding: 6px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-accent);
  cursor: pointer;
  white-space: nowrap;
}
.rec-row__solvebtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rec-row__blankhint,
.rec-row__unclearhint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
}
.rec-row__blankhint {
  color: var(--hc-text-muted);
}
.rec-row__unclearhint {
  color: var(--hc-warn, #b7791f);
}
</style>
