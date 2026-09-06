<script setup lang="ts">
/**
 * 原图批改叠加层（K12 原图批改 Phase 1，对标作业帮/小猿）。
 *
 * 范式：**检测坐标（识题回收 bbox）+ 程序确定性叠加**——绝不用 AI 生成批改图（不可控、会篡改原图）。
 * 原图为底，按每题归一化 bbox × 实际渲染尺寸，在学生作答区域绝对定位画 ✓（对·绿）/✗（错·红）。
 *
 * 🔴 硬性诚实门（设计文档 §6）：bbox 错位比不标更糟。本组件只在 bbox 存在且**合理**
 * （0~1 内、w/h>0、不越界）时渲染标记；缺失/非法 bbox 的题降级为纯文字批改（列在下方），
 * 绝不叠加错位红叉。归一化坐标天然适配任意渲染尺寸（用百分比定位，无需知道像素分辨率）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type { BBox, ParentTeachingGuideDTO, PhotoJobItemStatus } from '@/api/k12'
import { isValidGradingBBox } from '../graded-photo'
import { k12QuestionSourceDisplayLabel } from '../source-display'
import {
  PHOTO_PROCESS_ISSUE_COLOR,
  projectPhotoAssessmentStatus,
  type PhotoAssessmentStatusProjection,
} from '../photo-assessment-status'

/** 一道题的叠加标记：批改结论 + 可选订正/错因，按题 id 对齐其 bbox。 */
interface OverlayMark {
  /** 服务端冻结的稳定题目身份，仅用于可观察投影。 */
  problemId?: string
  /** 唯一状态真相：必须直接来自 PhotoJobItemDTO.status。 */
  status: PhotoJobItemStatus
  /** 学生作答区域归一化边界框；缺失/非法 → 降级纯文字批改（不叠加）。 */
  bbox?: BBox | null
  /** 原卷由大题到当前题的不可变题号 token。 */
  source_number_path?: string[]
  /** 原卷题号的冻结展示值；禁止由数组位置重新编号。 */
  display_label?: string
  /** 原卷可见大题与服务端系统序号分别投影，绝不合成为伪造原卷题号。 */
  source_section_path?: string[]
  source_section_label?: string
  system_section_ordinal?: number
  system_display_label?: string
  /** 题干（降级文字批改时展示，供家长对位）。 */
  question?: string
  /** OCR 冻结的学生原始作答。 */
  studentAnswer?: string
  /** 正确答案（订正，错题时展示）。 */
  correctAnswer?: string
  /** 第一个可复核的错误步骤。 */
  wrongStep?: string
  /** 错因。 */
  errorCause?: string
  /** wrong/process 的完整家长讲法；其余状态必须为空。 */
  parentGuide?: ParentTeachingGuideDTO | null
}

const props = defineProps<{
  /** 原始作业图；只读对照与老服务 bbox 叠加的底图。 */
  image: string
  /** 新服务返回的不可变批注图 data URL；存在时优先展示，禁止重复画 DOM 勾叉。 */
  annotatedImage?: string
  marks: OverlayMark[]
}>()

const { t } = useI18n()
const processIssueColor = PHOTO_PROCESS_ISSUE_COLOR

// 叠加层可开关：看原图 / 看批改（设计文档 §5 交互）。
const showOverlay = ref(true)
const displayedImage = computed(() =>
  showOverlay.value && props.annotatedImage
    ? props.annotatedImage
    : props.image || props.annotatedImage || '',
)
const showProgrammaticMarks = computed(() => showOverlay.value && !props.annotatedImage)

/**
 * bbox 合理性校验（错位防护）——与后端 normalizeBBox 同口径：
 * 四值皆有限数、x/y∈[0,1]、w/h 严格 >0、右下角不越界（含极小浮点误差容忍）。
 * 任何一项不满足即判非法 → 该题不叠加（降级文字批改）。
 */
interface IndexedMark extends OverlayMark {
  _i: number
  _valid: boolean
  _projection: PhotoAssessmentStatusProjection
}
const indexed = computed<IndexedMark[]>(() =>
  props.marks.map((mark, index) => {
    const projection = projectPhotoAssessmentStatus(mark.status)
    return {
      ...mark,
      _i: index,
      _projection: projection,
      _valid: projection.overlayVisible && isValidGradingBBox(mark.bbox),
    }
  }),
)
// 只有合法 bbox 才叠加；其余降级为下方文字批改（绝不错位）。
const positioned = computed(() => indexed.value.filter((m) => m._valid))
const degraded = computed(() => indexed.value.filter((m) => !m._valid))
const correctMarks = computed(() =>
  indexed.value.filter((mark) => mark._projection.summaryBucket === 'correct'),
)
const processMarks = computed(() =>
  indexed.value.filter((mark) => mark._projection.summaryBucket === 'process'),
)
const attentionMarks = computed(() =>
  indexed.value.filter((mark) => mark._projection.summaryBucket === 'attention'),
)
const detailMarks = computed(() =>
  indexed.value.filter((mark) => mark._projection.summaryBucket !== 'correct'),
)
// 当前契约没有 assessment_state=needs_review，不能把“bbox 缺失”冒充成“待人工复核”。
const pendingReviewCount = 0
const processOnly = computed(
  () => processMarks.value.length > 0 && attentionMarks.value.length === 0,
)
const visiblePositionedMarks = computed(() =>
  processOnly.value
    ? positioned.value.filter((mark) => mark._projection.summaryBucket === 'process')
    : positioned.value,
)
const headerSymbol = computed(() => (processOnly.value ? '⚠' : '✓'))
const summarySubtitle = computed(() => {
  if (processOnly.value) {
    return t('k12.overlay.summaryProcessSubtitle', {
      correct: correctMarks.value.length,
      process: processMarks.value.length,
    })
  }
  if (processMarks.value.length > 0) {
    return t('k12.overlay.summaryMixedSubtitle', {
      correct: correctMarks.value.length,
      process: processMarks.value.length,
      attention: attentionMarks.value.length,
    })
  }
  return t('k12.overlay.summarySubtitle', {
    correct: correctMarks.value.length,
    attention: attentionMarks.value.length,
  })
})

/**
 * 精确答案 bbox → 紧凑勾叉锚点。符号放在答案末端附近，不再用矩形覆盖整个答案；
 * 靠近右边缘时向左展开，避免被画布裁掉。
 */
function markStyle(b: BBox, status: PhotoJobItemStatus) {
  const rightEdge = b.x + b.w
  const percent = (value: number) => `${Math.round(value * 10_000) / 100}%`
  return {
    left: percent(rightEdge),
    top: percent(b.y + b.h * 0.4),
    transform:
      status === 'correct_with_process_issue'
        ? rightEdge > 0.94
          ? 'translate(-100%, 0)'
          : 'translate(0, 0)'
        : rightEdge > 0.94
          ? 'translate(-100%, -50%)'
          : 'translate(-10%, -50%)',
  }
}

function markDisplayLabel(mark: OverlayMark): string {
  return k12QuestionSourceDisplayLabel(mark)
}

function issueTitle(mark: OverlayMark): string {
  if (mark.status === 'blank_solved') {
    const label = markDisplayLabel(mark)
    return label ? `${label} · 已解答` : '已解答'
  }
  const projection = projectPhotoAssessmentStatus(mark.status)
  const issue =
    mark.status === 'correct_with_process_issue'
      ? t('k12.overlay.statusProcessIssue')
      : projection.tone === 'scope'
        ? t('k12.overlay.statusOutOfScope')
        : mark.errorCause || t('k12.overlay.needsAttention')
  const label =
    mark.status === 'correct_with_process_issue' && mark.system_display_label?.trim()
      ? mark.system_display_label.trim()
      : markDisplayLabel(mark)
  return label ? `${label} · ${issue}` : issue
}

function markStatusLabel(mark: IndexedMark): string {
  switch (mark.status) {
    case 'correct':
      return t('k12.overlay.correct')
    case 'correct_with_process_issue':
      return t('k12.overlay.statusProcessIssue')
    case 'wrong':
      return t('k12.overlay.wrong')
    case 'unanswered':
      return t('k12.overlay.statusUnanswered')
    case 'answer_unclear':
      return t('k12.overlay.statusUnclear')
    case 'blank_solved':
      return '已解答'
    case 'out_of_scope':
      return t('verify.outOfScope')
    default:
      return t('k12.overlay.pendingReview')
  }
}
</script>

<template>
  <div
    class="grade-result pg-overlay"
    data-testid="photo-grade-overlay"
    :data-assessment-status="processMarks.length ? 'correct_with_process_issue' : undefined"
    :style="{ '--photo-process-issue-color': processIssueColor }"
  >
    <div class="grade-result__head">
      <div class="grade-result__title">
        <span aria-hidden="true">{{ headerSymbol }}</span>
        <div>
          <b>{{ t('k12.overlay.completed') }}</b>
          <small>{{ summarySubtitle }}</small>
        </div>
        <div class="grade-result__actions">
          <slot name="actions" />
          <button
            class="grade-action"
            data-testid="overlay-toggle"
            type="button"
            :aria-pressed="showOverlay"
            @click="showOverlay = !showOverlay"
          >
            {{ showOverlay ? t('k12.overlay.hideAnnotations') : t('k12.overlay.showAnnotations') }}
          </button>
        </div>
      </div>

      <div
        class="grade-summary"
        :class="{ 'grade-summary--mixed': processMarks.length && attentionMarks.length }"
        :aria-label="t('k12.overlay.summaryLabel')"
      >
        <div class="grade-stat">
          <span>{{ t('k12.overlay.totalQuestions') }}</span
          ><b>{{ indexed.length }}</b>
        </div>
        <div class="grade-stat grade-stat--ok">
          <span>{{ t('k12.overlay.correctCount') }}</span
          ><b>{{ correctMarks.length }}</b>
        </div>
        <div v-if="processMarks.length" class="grade-stat grade-stat--process">
          <span>{{ t('k12.overlay.statusProcessIssue') }}</span
          ><b>{{ processMarks.length }}</b>
        </div>
        <div v-if="attentionMarks.length" class="grade-stat grade-stat--issue">
          <span>{{ t('k12.overlay.attentionCount') }}</span
          ><b>{{ attentionMarks.length }}</b>
        </div>
        <div
          class="grade-stat grade-stat--review"
          :class="{ 'is-empty': pendingReviewCount === 0 }"
        >
          <span>{{ t('k12.overlay.pendingReview') }}</span
          ><b>{{ pendingReviewCount }}</b>
        </div>
      </div>
    </div>

    <div class="grade-workspace">
      <div class="grade-media">
        <div class="grade-media__bar">
          <b>{{ t('k12.overlay.originalUntouched') }}</b>
          <span class="sp"></span>
          <span class="grade-media__hash">{{
            processOnly ? t('k12.overlay.originalArchived') : t('k12.overlay.originalReadOnly')
          }}</span>
        </div>

        <!-- 新契约优先展示服务端不可变批注图；老契约才走原图 + bbox 确定性叠加。 -->
        <div
          class="grade-photo pg-overlay__canvas"
          :class="{ 'grade-photo--process': processOnly }"
        >
          <img
            :src="displayedImage"
            class="pg-overlay__img"
            :alt="t('k12.overlay.imageAlt')"
            data-testid="overlay-image"
          />
          <template v-if="showProgrammaticMarks">
            <div
              v-for="m in visiblePositionedMarks"
              :key="m._i"
              class="pg-overlay__mark"
              :class="`pg-overlay__mark--${m._projection.tone}`"
              :style="markStyle(m.bbox as BBox, m.status)"
              :data-assessment-status="m.status"
              :data-problem-id="m.problemId || undefined"
              :data-testid="`overlay-mark-${m._i}`"
            >
              <span class="pg-overlay__sym" :data-testid="`overlay-sym-${m._i}`">{{
                m._projection.symbol
              }}</span>
            </div>
          </template>
        </div>

        <div class="grade-caption" :class="{ 'grade-caption--process': processOnly }">
          {{
            processOnly
              ? t('k12.overlay.processAnnotationCaption')
              : t('k12.overlay.annotationCaption')
          }}
        </div>
        <div class="grade-legend" :aria-label="t('k12.overlay.legendLabel')">
          <span data-grade-status="correct"><i>✓</i>{{ t('k12.overlay.statusCorrect') }}</span>
          <span v-if="!processOnly" data-grade-status="incorrect"
            ><i>×</i>{{ t('k12.overlay.statusIncorrect') }}</span
          >
          <span v-if="!processOnly" data-grade-status="unanswered"
            ><i>○</i>{{ t('k12.overlay.statusUnanswered') }}</span
          >
          <span v-if="!processOnly" data-grade-status="unclear"
            ><i>?</i>{{ t('k12.overlay.statusUnclear') }}</span
          >
          <span v-if="!processOnly" data-grade-status="partially_correct"
            ><i>◐</i>{{ t('k12.overlay.statusPartiallyCorrect') }}</span
          >
          <span data-grade-status="correct_with_process_issue"
            ><i>⚠</i>{{ t('k12.overlay.statusProcessIssue') }}</span
          >
          <span v-if="!processOnly" data-grade-status="needs_review"
            ><i>?</i>{{ t('k12.overlay.pendingReview') }}</span
          >
          <span v-if="!processOnly" data-grade-status="out_of_scope"
            ><i>—</i>{{ t('k12.overlay.statusOutOfScope') }}</span
          >
        </div>

        <!-- bbox 缺失只表示无法在图上可靠定位；不冒充“待人工复核”。 -->
        <div v-if="degraded.length" class="pg-overlay__degraded" data-testid="overlay-degraded">
          <div class="pg-overlay__degraded-title">{{ t('k12.overlay.degradedTitle') }}</div>
          <div
            v-for="m in degraded"
            :key="m._i"
            class="pg-overlay__degraded-item"
            :data-testid="`overlay-degraded-${m._i}`"
          >
            <span
              class="pg-overlay__degraded-verdict"
              :class="`is-${m._projection.tone}`"
              :data-assessment-status="m.status"
            >
              {{ m._projection.symbol + ' ' + markStatusLabel(m) }}
            </span>
            <span v-if="m.question" class="pg-overlay__degraded-q">
              <MarkdownRenderer class="pg-overlay__md-inline" :content="m.question" />
            </span>
            <span v-if="m.studentAnswer" class="pg-overlay__degraded-cause">
              原始作答：<MarkdownRenderer
                class="pg-overlay__md-inline"
                :content="m.studentAnswer"
              />
            </span>
            <span
              v-if="
                m._projection.summaryBucket !== 'correct' &&
                m._projection.tone !== 'scope' &&
                m.correctAnswer
              "
              class="pg-overlay__degraded-fix"
            >
              {{
                m.status === 'correct_with_process_issue'
                  ? t('k12.overlay.finalAnswer')
                  : t('k12.overlay.correctAnswer')
              }}：<MarkdownRenderer class="pg-overlay__md-inline" :content="m.correctAnswer" />
            </span>
            <span v-if="m.wrongStep" class="pg-overlay__degraded-cause">
              {{ t('k12.overlay.wrongStep') }}：<MarkdownRenderer
                class="pg-overlay__md-inline"
                :content="m.wrongStep"
              />
            </span>
            <span v-if="m.errorCause" class="pg-overlay__degraded-cause">
              {{ t('k12.overlay.cause') }}：<MarkdownRenderer
                class="pg-overlay__md-inline"
                :content="m.errorCause"
              />
            </span>
          </div>
        </div>
      </div>

      <div class="grade-analysis">
        <div class="grade-analysis__head">
          {{ processOnly ? t('k12.overlay.processExpanded') : t('k12.overlay.onlyAttention') }}
          <span>{{ t('k12.overlay.questionCount', { count: detailMarks.length }) }}</span>
        </div>

        <details
          v-for="m in detailMarks"
          :key="m._i"
          class="grade-card grade-card--issue"
          :class="`grade-card--${m._projection.tone}`"
          :data-assessment-status="m.status"
          :data-problem-id="m.problemId || undefined"
          :open="m._projection.defaultExpanded"
        >
          <summary>
            <span class="grade-card__status">{{ m._projection.symbol }}</span>
            <span>{{ issueTitle(m) }}</span>
          </summary>
          <div class="grade-card__body">
            <div
              v-if="m.question && m.status !== 'correct_with_process_issue'"
              class="grade-card__row"
            >
              <span>{{ t('k12.overlay.question') }}</span>
              <MarkdownRenderer class="grade-card__md" :content="m.question" />
            </div>
            <div v-if="m.studentAnswer" class="grade-card__row">
              <span>原始作答</span>
              <MarkdownRenderer class="grade-card__md" :content="m.studentAnswer" />
            </div>
            <div v-if="m._projection.tone !== 'scope' && m.correctAnswer" class="grade-card__row">
              <span>{{
                m.status === 'correct_with_process_issue'
                  ? t('k12.overlay.finalAnswer')
                  : t('k12.overlay.correctAnswer')
              }}</span>
              <b v-if="m.status === 'correct_with_process_issue'" class="grade-math"
                >{{ m.correctAnswer }} · {{ t('k12.overlay.statusCorrect') }}</b
              >
              <MarkdownRenderer v-else class="grade-card__md" :content="m.correctAnswer" />
            </div>
            <div v-if="m.wrongStep" class="grade-wrong-step">
              <b>{{ t('k12.overlay.wrongStep') }}</b
              ><br />
              <span v-if="m.status === 'correct_with_process_issue'" class="grade-math">{{
                m.wrongStep
              }}</span>
              <MarkdownRenderer v-else class="grade-card__md" :content="m.wrongStep" />
            </div>
            <div v-if="m.errorCause" class="grade-card__row">
              <span>{{ t('k12.overlay.cause') }}</span>
              <span v-if="m.status === 'correct_with_process_issue'">{{ m.errorCause }}</span>
              <MarkdownRenderer v-else class="grade-card__md" :content="m.errorCause" />
            </div>
            <template v-if="m.parentGuide">
              <div class="grade-card__row">
                <span>答案</span>
                <MarkdownRenderer class="grade-card__md" :content="m.parentGuide.answer" />
              </div>
              <div class="grade-card__row">
                <span>必要步骤</span>
                <ol class="grade-card__list">
                  <li v-for="step in m.parentGuide.full_solution_steps" :key="step">
                    <MarkdownRenderer class="grade-card__md" :content="step" />
                  </li>
                </ol>
              </div>
              <div class="grade-card__row">
                <span>本年级方法</span>
                <MarkdownRenderer
                  class="grade-card__md"
                  :content="m.parentGuide.grade_level_method"
                />
              </div>
              <div class="grade-card__row">
                <span>易错点</span>
                <ul class="grade-card__list">
                  <li v-for="mistake in m.parentGuide.likely_mistakes" :key="mistake">
                    <MarkdownRenderer class="grade-card__md" :content="mistake" />
                  </li>
                </ul>
              </div>
              <div class="grade-card__row">
                <span>家长怎么讲</span>
                <ol class="grade-card__list">
                  <li v-for="step in m.parentGuide.parent_teaching_sequence" :key="step">
                    <MarkdownRenderer class="grade-card__md" :content="step" />
                  </li>
                </ol>
              </div>
              <div class="grade-card__row">
                <span>可以追问</span>
                <ul class="grade-card__list">
                  <li v-for="question in m.parentGuide.follow_up_questions" :key="question">
                    <MarkdownRenderer class="grade-card__md" :content="question" />
                  </li>
                </ul>
              </div>
              <div class="grade-card__row">
                <span>怎么检查</span>
                <MarkdownRenderer class="grade-card__md" :content="m.parentGuide.checking_method" />
              </div>
            </template>
            <div v-if="m.status === 'out_of_scope'" class="grade-wrong-step is-scope">
              {{ t('verify.outOfScope') }}
            </div>
          </div>
        </details>

        <details class="grade-card grade-card--correct">
          <summary>
            <span class="grade-card__status">✓</span>
            <span>{{ t('k12.overlay.correctCollapsed', { count: correctMarks.length }) }}</span>
          </summary>
          <div class="grade-card__body">
            <div class="grade-correct-list">
              <div v-for="m in correctMarks" :key="m._i" class="grade-correct-item">
                <span>✓</span>
                <div>
                  <b v-if="markDisplayLabel(m)">{{ markDisplayLabel(m) }}</b>
                  <MarkdownRenderer
                    v-if="m.question"
                    class="grade-card__md"
                    :content="m.question"
                  />
                  <small>原始作答：{{ m.studentAnswer || '—' }} · 正确</small>
                </div>
              </div>
              <span v-if="correctMarks.length === 0" class="grade-correct-empty">{{
                t('k12.overlay.noCorrectQuestions')
              }}</span>
            </div>
          </div>
        </details>
      </div>
    </div>

    <div v-if="processMarks.length" class="grade-projection-status">
      {{ t('k12.overlay.processProjectionStatus') }}
    </div>
  </div>
</template>

<style scoped>
.grade-result {
  margin-top: 4px;
  border: 1px solid var(--hc-border);
  border-radius: 18px;
  background: var(--hc-bg-card);
  overflow: hidden;
  box-shadow: var(--hc-shadow-md);
  line-height: 1.6;
}
.grade-result__head {
  padding: 15px 16px 13px;
  border-bottom: 1px solid var(--hc-divider);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--hc-accent) 9%, var(--hc-bg-card)),
    var(--hc-bg-card)
  );
}
.grade-result__title {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.grade-result__title > span:first-child {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 18px;
  flex: none;
}
.grade-result[data-assessment-status='correct_with_process_issue']
  .grade-result__title
  > span:first-child {
  background: color-mix(in srgb, var(--photo-process-issue-color) 14%, transparent);
  color: var(--photo-process-issue-color);
}
.grade-result__title b {
  display: block;
  font-size: 14px;
  line-height: 1.35;
}
.grade-result__title small {
  display: block;
  margin-top: 3px;
  color: var(--hc-text-muted);
  font-size: 10.5px;
  line-height: 1.4;
}
.grade-result__actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.grade-action {
  padding: 5px 9px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.grade-action:hover {
  background: var(--hc-bg-hover);
}
.grade-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.grade-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
  margin-top: 12px;
}
.grade-summary--mixed {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
.grade-stat {
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid var(--hc-border-subtle);
  border-radius: 10px;
  background: color-mix(in srgb, var(--hc-bg-main) 62%, transparent);
}
.grade-stat span {
  display: block;
  color: var(--hc-text-muted);
  font-size: 9.5px;
  white-space: nowrap;
}
.grade-stat b {
  display: block;
  margin-top: 1px;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.grade-stat--ok b {
  color: var(--hc-success);
}
.grade-stat--issue b {
  color: var(--hc-error);
}
.grade-stat--process b {
  color: var(--photo-process-issue-color);
}
.grade-stat--review b {
  color: var(--hc-warning);
}
.grade-stat--review.is-empty {
  opacity: 0.45;
}
.grade-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 480px;
}
.grade-media {
  min-width: 0;
  padding: 14px;
  border-bottom: 1px solid var(--hc-divider);
  background: color-mix(in srgb, var(--hc-bg-input) 74%, transparent);
}
.grade-media__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
  color: var(--hc-text-secondary);
  font-size: 10.5px;
}
.grade-media__bar b {
  color: var(--hc-text-primary);
  font-size: 11.5px;
}
.grade-media__bar .sp {
  flex: 1;
}
.grade-media__hash {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 9px;
  color: var(--hc-text-muted);
}
.grade-photo {
  position: relative;
  isolation: isolate;
  width: fit-content;
  max-width: min(680px, 100%);
  min-height: 160px;
  margin: 0 auto;
  overflow: hidden;
  border-radius: 13px;
  background: var(--hc-bg-card);
  box-shadow: 0 14px 34px rgb(28 22 20 / 18%);
  border: 1px solid color-mix(in srgb, var(--hc-border) 72%, #7a6d67);
}
.grade-photo--process {
  width: 100%;
  max-width: 320px;
  min-height: 0;
  aspect-ratio: 1086 / 1448;
  background: #d7d0cc;
}
.grade-photo--process .pg-overlay__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pg-overlay__img {
  display: block;
  max-width: 100%;
  height: auto;
}
/* 绝对定位标记：只画紧凑勾叉，不画边框、底色或订正条，避免遮住孩子原笔迹。 */
.pg-overlay__mark {
  position: absolute;
  pointer-events: none;
  z-index: 1;
}
.pg-overlay__sym {
  display: block;
  font-size: clamp(16px, 2.4vw, 30px);
  font-weight: 900;
  line-height: 1;
  -webkit-text-stroke: 1px #fff;
  text-shadow:
    -1px -1px 0 #fff,
    1px -1px 0 #fff,
    -1px 1px 0 #fff,
    1px 1px 0 #fff;
}
.pg-overlay__mark--correct .pg-overlay__sym {
  color: var(--hc-success, #2ea86b);
}
.pg-overlay__mark--wrong .pg-overlay__sym {
  color: var(--hc-error, #e05a5a);
}
.pg-overlay__mark--process .pg-overlay__sym {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 50%;
  padding: 1px 6px;
  background: var(--photo-process-issue-color);
  color: #fff;
  font:
    800 25px/1 ui-rounded,
    'SF Pro Rounded',
    sans-serif;
  -webkit-text-stroke: 0;
  text-shadow: none;
  box-shadow: 0 5px 14px rgba(28, 25, 25, 0.25);
}
.pg-overlay__mark--unanswered .pg-overlay__sym,
.pg-overlay__mark--unclear .pg-overlay__sym,
.pg-overlay__mark--review .pg-overlay__sym {
  color: var(--hc-warning);
}
.grade-caption {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 9px;
  color: var(--hc-text-muted);
  font-size: 10px;
  text-align: center;
}
.grade-caption::before {
  content: '◇';
  color: var(--hc-success);
  font-weight: 900;
}
.grade-caption--process::before {
  content: '⚠';
  color: var(--photo-process-issue-color);
}
.grade-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 10px;
}
.grade-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid var(--hc-border-subtle);
  border-radius: 6px;
  background: var(--hc-bg-card);
  color: var(--hc-text-muted);
  font-size: 9px;
  white-space: nowrap;
}
.grade-legend i {
  width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font:
    800 9px/1 ui-rounded,
    sans-serif;
  color: #fff;
  background: var(--hc-text-muted);
  font-style: normal;
}
.grade-legend [data-grade-status='correct'] i {
  background: var(--hc-success);
}
.grade-legend [data-grade-status='incorrect'] i {
  background: var(--hc-error);
}
.grade-legend [data-grade-status='unanswered'] i,
.grade-legend [data-grade-status='unclear'] i,
.grade-legend [data-grade-status='needs_review'] i {
  background: var(--hc-warning);
}
.grade-legend [data-grade-status='partially_correct'] i,
.grade-legend [data-grade-status='correct_with_process_issue'] i {
  background: #a56bd6;
}
.grade-analysis {
  min-width: 0;
  padding: 14px;
  overflow: auto;
}
.grade-analysis__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 9px;
  font-size: 11.5px;
  font-weight: 700;
}
.grade-analysis__head span {
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
  color: var(--hc-warning);
  font-size: 9.5px;
}
.grade-result[data-assessment-status='correct_with_process_issue'] .grade-analysis__head span {
  background: color-mix(in srgb, var(--photo-process-issue-color) 12%, transparent);
  color: var(--photo-process-issue-color);
}
.grade-card {
  border: 1px solid var(--hc-border);
  border-radius: 11px;
  background: var(--hc-bg-card);
  overflow: hidden;
  margin-bottom: 8px;
  transition:
    border-color 0.18s,
    box-shadow 0.18s;
}
.grade-card[open] {
  border-color: color-mix(in srgb, var(--hc-warning) 45%, var(--hc-border));
  box-shadow: var(--hc-shadow-sm);
}
.grade-card summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 11px;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 700;
}
.grade-card summary::-webkit-details-marker {
  display: none;
}
.grade-card summary::after {
  content: '⌄';
  margin-left: auto;
  color: var(--hc-text-muted);
  transition: transform 0.15s;
}
.grade-card[open] summary::after {
  transform: rotate(180deg);
}
.grade-card__status {
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: var(--hc-error);
  font-weight: 900;
  flex: none;
}
.grade-card--correct .grade-card__status {
  background: var(--hc-success);
}
.grade-card--process[open] {
  border-color: color-mix(in srgb, var(--photo-process-issue-color) 52%, var(--hc-border));
}
.grade-card--process .grade-card__status {
  background: var(--photo-process-issue-color);
}
.grade-card--process .grade-wrong-step {
  border-left-color: var(--photo-process-issue-color);
  background: color-mix(in srgb, var(--photo-process-issue-color) 8%, transparent);
}
.grade-card--scope .grade-card__status,
.grade-card--neutral .grade-card__status {
  background: var(--hc-text-muted);
}
.grade-card--unanswered .grade-card__status,
.grade-card--unclear .grade-card__status,
.grade-card--review .grade-card__status {
  background: var(--hc-warning);
}
.grade-card__body {
  padding: 0 11px 11px;
  border-top: 1px solid var(--hc-divider);
}
.grade-card__row {
  display: grid;
  grid-template-columns: 66px 1fr;
  gap: 7px;
  padding-top: 8px;
  font-size: 10.5px;
  line-height: 1.55;
}
.grade-card__row > span:first-child {
  color: var(--hc-text-muted);
}
.grade-card__row b {
  font-weight: 650;
}
.grade-card__list {
  display: grid;
  gap: 3px;
  margin: 0;
  padding-left: 18px;
}
.grade-card__md :deep(p) {
  margin: 0;
}
.grade-math {
  color: var(--hc-text-primary);
  font-family: 'SF Mono', Menlo, monospace;
}
.grade-wrong-step {
  padding: 8px 9px;
  margin-top: 9px;
  border-left: 3px solid var(--hc-error);
  border-radius: 0 7px 7px 0;
  background: color-mix(in srgb, var(--hc-error) 7%, transparent);
  font-size: 10.5px;
  line-height: 1.55;
}
.grade-wrong-step.is-scope {
  border-left-color: var(--hc-text-muted);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
}
.grade-correct-list {
  display: grid;
  gap: 6px;
  padding-top: 8px;
}
.grade-correct-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 7px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--hc-success) 6%, transparent);
  font-size: 10.5px;
  line-height: 1.45;
}
.grade-correct-item > span:first-child {
  color: var(--hc-success);
  font-weight: 900;
}
.grade-correct-empty {
  padding: 8px;
  color: var(--hc-text-muted);
  font-size: 10.5px;
}
.grade-projection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-top: 1px solid var(--hc-divider);
  color: var(--hc-text-muted);
  font-size: 9.5px;
}
.grade-projection-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--hc-success) 12%, transparent);
}
.pg-overlay__degraded {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  border-inline-start: 3px solid var(--hc-warning, #e0a03a);
  background: var(--hc-bg-card);
  border-start-end-radius: var(--hc-radius-md);
  border-end-end-radius: var(--hc-radius-md);
}
.pg-overlay__degraded-title {
  font-size: 11.5px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
}
.pg-overlay__degraded-item {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.pg-overlay__degraded-verdict {
  font-weight: 700;
}
.pg-overlay__degraded-verdict.is-correct {
  color: var(--hc-success, #2ea86b);
}
.pg-overlay__degraded-verdict.is-wrong {
  color: var(--hc-error, #e05a5a);
}
.pg-overlay__degraded-verdict.is-process {
  color: var(--photo-process-issue-color);
}
.pg-overlay__degraded-verdict.is-unanswered,
.pg-overlay__degraded-verdict.is-unclear,
.pg-overlay__degraded-verdict.is-review {
  color: var(--hc-warning);
}
.pg-overlay__degraded-verdict.is-scope {
  color: var(--hc-text-muted);
}
.pg-overlay__degraded-q {
  color: var(--hc-text-primary);
}
.pg-overlay__md-inline {
  display: inline;
}
.pg-overlay__md-inline :deep(p) {
  display: inline;
  margin: 0;
}
@media (max-width: 900px) {
  .grade-summary {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 600px) {
  .grade-result__title {
    flex-wrap: wrap;
  }
  .grade-result__actions {
    width: 100%;
    justify-content: flex-start;
    margin-left: 44px;
  }
}
</style>
