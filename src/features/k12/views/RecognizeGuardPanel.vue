<script setup lang="ts">
/**
 * 拍照识题回显护栏面板（#1 · 原型 app.html #chatTutorView 的信任链上游兜底，PRD §3.2.5）。
 *
 * 流程：作业图片 base64 → store.recognize 分题 → **家长核对回显「我读到的是…对吗？」✓读对/✏️读错**
 * （OCR 低置信度必核对）→ 逐题填孩子作答 → store.grade 验算徽章（#2）。
 * 无年级时（冷启动首拍）据识出的知识点倒查课标推断年级建档（#3，store.coldStart）。
 *
 * 本层只做识题回显 + 批改触发；题干正误由家长核对护栏兜底，答案对错由后端 solve 验算链裁决，不造答案。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useK12Store } from '../store'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'
import HcSelect from '@/components/common/HcSelect.vue'
import VerifyBadge from '@/shell/chat/VerifyBadge.vue'
import PrepCardPanel from './PrepCardPanel.vue'
import type { RecognizedQuestion } from '@/api/k12'
import type { VerifyResult } from '@/contracts'

// 审计单-High-2（bug-20260709）：本组件全部 API 调用的 agent = agents.name（后端隔离键），
// 故 prop 名就叫 agentId——曾命名 agentName 导致上游把 display_name 传进来，写错孩子作用域。
// initialImage（BUG-20260709 拍照发题不解题）：composer 粘贴/上传改道进来的图片 dataURL，
// 传入即预填并自动识题（原型契约「粘贴作业照片即自动 OCR 回显护栏」），家长零多余点击。
const props = defineProps<{ agentId: string; grade?: string; initialImage?: string }>()

const { t } = useI18n()
const store = useK12Store()

/** 一道识出的题在护栏里的可编辑本地状态 */
interface GuardRow {
  problem: string // 家长可就地订正的题干（初值=识别原文）
  knowledgePoints: string[]
  editing: boolean
  studentAnswer: string
  grading: boolean
  verify: VerifyResult | null
  recorded: boolean
  recordDeduplicated: boolean
  solution: string
  wrongStep: string
  errorCause: string
}

const imageB64 = ref('')
const rows = ref<GuardRow[]>([])
const recognizing = ref(false)
const errMsg = ref('')
const confirmed = ref(false)
const selectedSubject = ref('')
let agentGeneration = 0
const subjectOptions = computed(() => K12_GRADE_SUBJECT_OPTIONS.map(({ value, labelKey }) => ({
  value,
  label: t(labelKey),
})))

// 冷启动倒查建档（#3）：仅在无年级时可用（识题产出知识点后倒查推断）
const coldStarting = ref(false)
const coldStartResult = ref<{ grade: string; inferred: boolean } | null>(null)
const noGrade = computed(() => !props.grade || !props.grade.trim())
const canColdStart = computed(() => noGrade.value && rows.value.length > 0 && !coldStartResult.value)
// 汇总所有识题知识点（去重、保序）供倒查
const allKnowledgePoints = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows.value) for (const kp of r.knowledgePoints) if (!seen.has(kp)) { seen.add(kp); out.push(kp) }
  return out
})

function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => { imageB64.value = String(reader.result ?? '') }
  reader.readAsDataURL(file)
}

// 多孩切换是状态边界：立即清空本地识题态，并让旧 agent 的在途响应失效。
watch(() => props.agentId, () => {
  agentGeneration += 1
  imageB64.value = ''
  rows.value = []
  recognizing.value = false
  errMsg.value = ''
  confirmed.value = false
  selectedSubject.value = ''
  coldStarting.value = false
  coldStartResult.value = null
})

// composer 改道图片：预填 + 自动识题（家长粘贴/上传即进护栏，无需再点「识题」）
watch(() => props.initialImage, (img) => {
  if (!img || !img.trim()) return
  imageB64.value = img
  void run()
}, { immediate: true })

async function run() {
  if (!imageB64.value.trim() || recognizing.value) return
  const generation = agentGeneration
  recognizing.value = true
  errMsg.value = ''
  confirmed.value = false
  coldStartResult.value = null
  try {
    const questions = await store.recognize(imageB64.value.trim())
    if (generation !== agentGeneration) return
    rows.value = questions.map((q: RecognizedQuestion) => ({
      problem: q.question,
      knowledgePoints: q.knowledge_points ?? [],
      editing: false,
      studentAnswer: '',
      grading: false,
      verify: null,
      recorded: false,
      recordDeduplicated: false,
      solution: '',
      wrongStep: '',
      errorCause: '',
    }))
  } catch (e) {
    if (generation !== agentGeneration) return
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (generation === agentGeneration) recognizing.value = false
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

// 命名避开 props.grade（vue/no-dupe-keys：script 顶层标识符与 prop 同名会在模板里撞键）
async function gradeRow(i: number) {
  const row = rows.value[i]
  if (!row || !row.problem.trim() || row.grading) return
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
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    row.grading = false
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
    </div>
    <p class="rec-panel__intro">{{ t('k12.recognize.intro') }}</p>

    <!-- 图片输入：文件选择 + base64 粘贴回退 -->
    <label class="rec-panel__file">
      <input type="file" accept="image/*" data-testid="recognize-file" @change="onFile" />
      <span>{{ t('k12.recognize.pickImage') }}</span>
    </label>
    <textarea
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
        {{ coldStarting ? t('k12.recognize.coldStartInferring') : t('k12.recognize.coldStartInfer') }}
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
          <button
            class="rec-row__toggle"
            :data-testid="`rq-edit-${i}`"
            @click="toggleEdit(row)"
          >
            {{ row.editing ? t('k12.recognize.readOk') : t('k12.recognize.readWrong') }}
          </button>
        </div>
        <div v-if="row.knowledgePoints.length" class="rec-row__kp">
          {{ t('k12.recognize.kpLabel') }}：<span v-for="kp in row.knowledgePoints" :key="kp" class="rec-row__kpchip">{{ kp }}</span>
        </div>

        <VerifyBadge v-if="row.verify" :result="row.verify" />
        <div
          v-if="row.verify && (row.solution || row.wrongStep || row.errorCause)"
          class="rec-row__details"
          :data-testid="`rq-grade-details-${i}`"
        >
          <div v-if="row.solution"><b>{{ t('k12.recognize.solution') }}：</b>{{ row.solution }}</div>
          <div v-if="row.wrongStep"><b>{{ t('k12.recognize.wrongStep') }}：</b>{{ row.wrongStep }}</div>
          <div v-if="row.errorCause"><b>{{ t('k12.recognize.errorCause') }}：</b>{{ row.errorCause }}</div>
        </div>
        <div v-if="row.verify && row.recorded" class="rec-row__recorded">
          🗂 {{ t('k12.recognize.recorded') }}
          <span
            v-if="row.recordDeduplicated"
            :data-testid="`rq-record-deduplicated-${i}`"
          > · {{ t('k12.recognize.recordDeduplicated') }}</span>
        </div>

        <div v-if="confirmed" class="rec-row__grade">
          <input
            v-model="row.studentAnswer"
            class="rec-row__answer"
            :data-testid="`rq-answer-${i}`"
            :placeholder="t('k12.recognize.answerPlaceholder')"
          />
          <button
            class="rec-row__gradebtn"
            :data-testid="`rq-grade-${i}`"
            :disabled="!row.problem.trim() || !selectedSubject || row.grading"
            @click="gradeRow(i)"
          >
            {{ row.grading ? t('k12.recognize.grading') : t('k12.recognize.grade') }}
          </button>
        </div>
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
    </div>
    <p v-else-if="!recognizing" class="rec-panel__empty">{{ t('k12.recognize.empty') }}</p>

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
.rec-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }
.rec-panel__head { display: flex; align-items: center; }
.rec-panel__title { font-size: 13px; font-weight: 700; flex: 1; }
.rec-panel__intro { font-size: 12px; color: var(--hc-text-muted); line-height: 1.5; margin: 0; }
.rec-panel__file {
  display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer;
  padding: 6px 10px; border: 0.5px dashed var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-secondary);
}
.rec-panel__file input { font-size: 11px; }
.rec-panel__b64 {
  width: 100%; box-sizing: border-box; font-size: 11px; padding: 6px 8px; resize: vertical;
  border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-muted);
}
.rec-panel__run {
  font-size: 12.5px; padding: 8px; border: 0.5px solid var(--hc-border-hl); border-radius: var(--hc-radius-md);
  background: var(--hc-accent-subtle); color: var(--hc-accent); cursor: pointer;
}
.rec-panel__run:disabled { opacity: 0.5; cursor: not-allowed; }
.rec-panel__err { font-size: 12px; color: var(--hc-danger, #e05a5a); }
.rec-panel__subject {
  display: flex; flex-direction: column; gap: 5px; max-width: 260px;
  font-size: 12.5px; color: var(--hc-text-secondary);
}
.rec-row__details {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; font-size: 12px;
  line-height: 1.5; color: var(--hc-text-secondary); background: var(--hc-bg-elevated);
  border-inline-start: 3px solid var(--hc-accent);
  border-start-end-radius: var(--hc-radius-sm); border-end-end-radius: var(--hc-radius-sm);
}
.rec-row__details b { color: var(--hc-text-primary); }
.rec-panel__empty { font-size: 12px; color: var(--hc-text-muted); text-align: center; padding: 8px; margin: 0; }
/* 冷启动倒查建档 */
.rec-cold {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border-inline-start: 3px solid var(--hc-warn, #e0a03a); background: var(--hc-bg-elevated);
  border-start-end-radius: var(--hc-radius-md); border-end-end-radius: var(--hc-radius-md);
}
.rec-cold__hint { font-size: 12px; color: var(--hc-text-secondary); line-height: 1.5; }
.rec-cold__btn {
  align-self: flex-start; font-size: 12px; padding: 6px 12px; border: 0.5px solid var(--hc-border-hl);
  border-radius: var(--hc-radius-md); background: var(--hc-bg-input); color: var(--hc-text-primary); cursor: pointer;
}
.rec-cold--done { border-inline-start-color: var(--hc-success); font-size: 12px; color: var(--hc-text-primary); }
/* 识题回显护栏 */
.rec-guard { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.rec-guard__title { font-size: 12.5px; font-weight: 700; color: var(--hc-text-primary); }
.rec-guard__confirm {
  align-self: flex-end; font-size: 12px; padding: 7px 14px; border: 0.5px solid var(--hc-border-hl);
  border-radius: var(--hc-radius-md); background: var(--hc-accent-subtle); color: var(--hc-accent); cursor: pointer;
}
.rec-guard__confirm:disabled { opacity: 0.5; cursor: not-allowed; }
.rec-row {
  border-inline-start: 3px solid var(--hc-accent); padding: 8px 10px;
  background: var(--hc-bg-elevated);
  border-start-end-radius: var(--hc-radius-md); border-end-end-radius: var(--hc-radius-md);
  display: flex; flex-direction: column; gap: 6px;
}
.rec-row__q { display: flex; align-items: center; gap: 8px; }
.rec-row__qtext { flex: 1; font-size: 13px; color: var(--hc-text-primary); }
.rec-row__edit {
  flex: 1; font-size: 13px; padding: 5px 8px; border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
.rec-row__toggle {
  font-size: 11.5px; padding: 3px 8px; border: none; border-radius: 7px; white-space: nowrap;
  background: transparent; color: var(--hc-accent); cursor: pointer;
}
.rec-row__kp { font-size: 11.5px; color: var(--hc-text-muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.rec-row__kpchip {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: var(--hc-accent-subtle); color: var(--hc-accent);
}
.rec-row__recorded { font-size: 11px; color: var(--hc-text-muted); }
.rec-row__grade { display: flex; gap: 6px; }
.rec-row__answer {
  flex: 1; font-size: 12.5px; padding: 6px 8px; border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
.rec-row__gradebtn {
  font-size: 12px; padding: 6px 12px; border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-primary); cursor: pointer; white-space: nowrap;
}
.rec-row__gradebtn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
