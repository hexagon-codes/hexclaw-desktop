<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type {
  CurriculumProgressDTO,
  MistakePracticeGenerationDTO,
  WeeklyArithmeticBatchState,
  WeeklyPracticeHistorySummaryDTO,
  WeeklyPracticeItemDTO,
  WeeklyPracticePlanDTO,
  WeeklyPracticePrepareOutputResp,
  WeeklyPracticeSection,
  WeeklyPracticeSettingsDTO,
  WeeklyPracticeSnapshotDTO,
  WeeklyPracticeTrackDTO,
} from '@/api/k12'
import K12BookTabs from './K12BookTabs.vue'
import K12ManualQuestionCountField from './K12ManualQuestionCountField.vue'
import K12MistakeReviewMenu from './K12MistakeReviewMenu.vue'
import { projectMistakePracticeGeneration } from '../practice-generation-projection'

const props = defineProps<{
  progress: CurriculumProgressDTO | null
  settings: WeeklyPracticeSettingsDTO | null
  plan: WeeklyPracticePlanDTO | null
  history: WeeklyPracticeHistorySummaryDTO[]
  historySnapshot?: WeeklyPracticeSnapshotDTO | null
  output?: WeeklyPracticePrepareOutputResp | null
  loading?: boolean
  busy?: boolean
  error?: string
  deliveryLabel?: string
  deliveryDisabled?: boolean
  view?: 'current' | 'history'
  practiceGenerationByMistake?: Record<string, MistakePracticeGenerationDTO>
  practiceGenerationBusy?: string[]
  /** 学情趋势数据可用时投影原型「趋势 ↑ 在进步」pill（app.html 20260709 评审）。 */
  trendPill?: boolean
}>()

type ArithmeticAction = 'create' | 'start' | 'resume' | 'retry'

const emit = defineEmits<{
  (e: 'open-progress'): void
  (e: 'retry'): void
  (e: 'join-practice', item: WeeklyPracticeItemDTO): void
  (e: 'view-practice', item: WeeklyPracticeItemDTO): void
  (e: 'update:view', view: 'current' | 'history'): void
  (e: 'open-history', item: WeeklyPracticeHistorySummaryDTO): void
  (
    e: 'history-artifact-action',
    intent: {
      action: 'print' | 'send_im'
      snapshot_id: string
      artifact_id: string
    },
  ): void
  (e: 'history-insights', snapshotId: string): void
  (
    e: 'arithmetic-action',
    intent: { action: ArithmeticAction; batch_id?: string; item_count?: number },
  ): void
  (e: 'prepare-textbook', intent: { item_count: number }): void
  (e: 'refresh-textbook'): void
  (e: 'defer-item', item: WeeklyPracticeItemDTO): void
  (e: 'suppress-item', item: WeeklyPracticeItemDTO): void
  (e: 'retry-mistake-practice', recordId: string): void
}>()

const activeTab = ref<'current' | 'history'>(props.view ?? 'current')
const historyDetail = ref<WeeklyPracticeHistorySummaryDTO | null>(null)
const selectedTextbookItemCount = ref<number | null>(5)
const selectedArithmeticItemCount = ref<number | null>(10)

// 错题练习集六态由共享投影统一：available/re_add 可加入，pending 正在出题，
// joined 可查看新题，failed 可重试，hidden 从本周列表移除。
// 掌握状态投影（架构词表 + 原型 .stpill 三态色）：
// new/explained=未掌握（todo 红）· retried=已重做（done 黄）· mastered=证据已掌握（got 绿）· archived=已归档（todo 红）。
function masteryPill(masteryStatus: string | undefined): { label: string; cls: string } | null {
  switch (masteryStatus) {
    case 'mastered':
      return { label: '证据已掌握', cls: 'got' }
    case 'retried':
      return { label: '已重做', cls: 'done' }
    case 'archived':
      return { label: '已归档', cls: 'todo' }
    case 'new':
    case 'explained':
      return { label: '未掌握', cls: 'todo' }
    default:
      return null
  }
}

function kpillSubjectClass(subject: string | undefined): string {
  switch (subject) {
    case '语文':
      return 'kpill--chi'
    case '英语':
      return 'kpill--eng'
    case '科学':
      return 'kpill--sci'
    case '信息科技':
      return 'kpill--it'
    default:
      return ''
  }
}

function practiceProjection(item: WeeklyPracticeItemDTO) {
  return projectMistakePracticeGeneration(
    item.source_kind === 'mistake'
      ? props.practiceGenerationByMistake?.[item.source_ref]?.state
      : undefined,
  )
}
const weeklyViewTabs = [
  { key: 'current', label: '本周' },
  { key: 'history', label: '历史' },
] as const

watch(
  () => props.view,
  (view) => {
    if (view) activeTab.value = view
  },
)

function selectView(key: string) {
  const view = key === 'history' ? 'history' : 'current'
  activeTab.value = view
  emit('update:view', view)
}

const sectionLabels: Record<WeeklyPracticeSection, string> = {
  due_review: '到期复习',
  textbook_consolidation: '同步巩固',
  arithmetic_warmup: '口算热身',
}
const sectionDescriptions: Record<WeeklyPracticeSection, string> = {
  due_review: '真实错题按复习调度到期，优先安排',
  textbook_consolidation: '只补充已确认教材进度内的内容，默认不自动生成',
  arithmetic_warmup: '只练已经学过的运算，按本次题量手动开始',
}
const generationLabels: Record<WeeklyPracticeItemDTO['generation_method'], string> = {
  original: '原题',
  ai_variant: 'AI变式',
  ai_generated: 'AI生成',
  rule_generated: '规则生成',
}
const sourceLabels: Record<string, string> = {
  mistake: '真实错题',
  curriculum: '已确认教材进度',
  textbook: '已确认教材进度',
  learned_scope: '已学运算范围',
  arithmetic: '已学运算范围',
}

const visibleTracks = computed<WeeklyPracticeTrackDTO[]>(() => {
  const tracks = props.plan?.tracks ?? []
  const bySection = new Map(tracks.map((track) => [track.plan_section, track]))
  return (Object.keys(sectionLabels) as WeeklyPracticeSection[]).map((section) => {
    const fallback: WeeklyPracticeTrackDTO = {
      plan_section: section,
      status: 'disabled',
      failure_message: '',
      items: [],
      arithmetic_batch: null,
    }
    return bySection.get(section) ?? fallback
  })
})

const verifiedItems = (track: WeeklyPracticeTrackDTO) =>
  track.items
    .filter(
      (item) =>
        item.verification.status === 'verified' && practiceProjection(item).kind !== 'hidden',
    )
    .sort((left, right) => left.position - right.position)

const totalCount = computed(() =>
  visibleTracks.value.reduce((sum, track) => sum + verifiedItems(track).length, 0),
)
// hero meta 对齐原型（app.html:3101）：本周错题 = 到期复习项数；
// 同步巩固/口算热身未就绪（recommendation 不可用）时投影「待准备/待开始」。
const weeklyMistakeCount = computed(
  () =>
    verifiedItems(visibleTracks.value.find((track) => track.plan_section === 'due_review')!).length,
)
function supplementLabel(
  section: 'textbook_consolidation' | 'arithmetic_warmup',
  recommendation: { availability?: string } | undefined,
  count: number,
): string {
  const automaticEnabled =
    section === 'textbook_consolidation'
      ? props.settings?.textbook_consolidation_enabled
      : props.settings?.arithmetic_warmup_enabled
  if (automaticEnabled === false) return section === 'textbook_consolidation' ? '待准备' : '待开始'
  if (recommendation?.availability === 'available') return String(count)
  return section === 'textbook_consolidation' ? '待准备' : '待开始'
}
const dueReviewCount = computed(
  () =>
    verifiedItems(visibleTracks.value.find((track) => track.plan_section === 'due_review')!).length,
)
const textbookRecommendation = computed(
  () => props.plan?.manual_track_recommendations?.textbook_consolidation,
)
const arithmeticRecommendation = computed(
  () => props.plan?.manual_track_recommendations?.arithmetic_warmup,
)

// BUG-20260815-001 ③：补充轨缺教材进度时投影已批准中文引导，不显示服务端英文
// failure_message（如 curriculum progress setup required）。
function setupRequiredFor(section: WeeklyPracticeSection): boolean {
  const recommendation =
    section === 'textbook_consolidation'
      ? textbookRecommendation.value
      : section === 'arithmetic_warmup'
        ? arithmeticRecommendation.value
        : undefined
  return recommendation?.availability === 'setup_required'
}

const setupRequiredMessage: Record<string, string> = {
  textbook_consolidation: '先设置教材进度，再生成同步巩固题',
  arithmetic_warmup: '先设置教材进度，再生成口算热身题',
}

watch(
  () => textbookRecommendation.value?.selected_item_count,
  (itemCount) => {
    if (itemCount) selectedTextbookItemCount.value = itemCount
  },
  { immediate: true },
)
watch(
  () => arithmeticRecommendation.value?.selected_item_count,
  (itemCount) => {
    if (itemCount) selectedArithmeticItemCount.value = itemCount
  },
  { immediate: true },
)

function verifiedPageLabel(item: WeeklyPracticeItemDTO): string {
  const verification = item.verification
  if (
    verification.status !== 'verified' ||
    !verification.textbook_binding_id ||
    !verification.unit_id ||
    verification.verified_page_from === undefined ||
    verification.verified_page_to === undefined
  ) {
    return ''
  }
  return verification.verified_page_from === verification.verified_page_to
    ? `P${verification.verified_page_from}`
    : `P${verification.verified_page_from}–${verification.verified_page_to}`
}

function evidenceLabel(item: WeeklyPracticeItemDTO): string {
  const evidence = item.verification.evidence_refs.filter(Boolean).join(' · ')
  const page = verifiedPageLabel(item)
  return [evidence, page].filter(Boolean).join(' · ')
}

function compactVolumeLabel(volume: string | undefined): string {
  const match = /^(.*)年级(上|下)册$/.exec(volume ?? '')
  return match ? `${match[1]}${match[2]}` : (volume ?? '')
}

const progressLabel = computed(() => {
  const progress = props.progress
  if (!progress) return ''
  const parts = [
    [progress.textbook_edition, progress.volume].filter(Boolean).join(''),
    progress.unit_title,
    progress.lesson_title,
  ].filter(Boolean)
  let pageLabel = ''
  if (
    progress.page_verification_status === 'verified' &&
    progress.verified_page_from !== undefined &&
    progress.verified_page_to !== undefined
  ) {
    pageLabel =
      progress.verified_page_from === progress.verified_page_to
        ? `P${progress.verified_page_from}`
        : `P${progress.verified_page_from}–${progress.verified_page_to}`
  }
  return pageLabel ? `${parts.join(' · ')}· ${pageLabel}` : parts.join(' · ')
})

const compactProgressLabel = computed(() => {
  const progress = props.progress
  const unitLabel = progress?.unit_title?.replace(/「[^」]*」/g, '').trim()
  if (!progress) return ''
  const parts = [
    [progress.textbook_edition, compactVolumeLabel(progress.volume)].filter(Boolean).join(''),
    unitLabel,
  ].filter(Boolean)
  if (
    progress.page_verification_status === 'verified' &&
    progress.verified_page_from !== undefined &&
    progress.verified_page_to !== undefined
  ) {
    parts.push(
      progress.verified_page_from === progress.verified_page_to
        ? `P${progress.verified_page_from}`
        : `P${progress.verified_page_from}–${progress.verified_page_to}`,
    )
  }
  return parts.join(' · ')
})

function monthDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  return `${Number(match[2])}月${Number(match[3])}日`
}

function archiveDateLabel(item: WeeklyPracticeHistorySummaryDTO): string {
  return `${monthDay(item.local_start_date)}–${monthDay(item.local_end_date)}`
}

function archiveWeekLabel(item: WeeklyPracticeHistorySummaryDTO): string {
  return `${item.iso_week_year}年第${item.iso_week_number}周`
}

function archiveResultLabel(item: WeeklyPracticeHistorySummaryDTO): string {
  return `${item.item_count} 道 · ${item.correct_count} 对 ${item.wrong_count} 错`
}

function openHistory(item: WeeklyPracticeHistorySummaryDTO) {
  historyDetail.value = item
  emit('open-history', item)
}

function arithmeticAction(track: WeeklyPracticeTrackDTO): {
  label: string
  disabled: boolean
  action?: ArithmeticAction
  batch_id?: string
} | null {
  if (track.plan_section !== 'arithmetic_warmup') return null
  const batch = track.arithmetic_batch
  if (!batch) {
    const availability =
      arithmeticRecommendation.value?.availability ??
      (track.status === 'failed' ? 'failed_terminal' : 'available')
    if (availability === 'processing') {
      return {
        label: `正在生成 ${selectedArithmeticItemCount.value ?? 0} 道…`,
        disabled: true,
      }
    }
    return availability === 'available'
      ? {
          label: '生成口算热身题',
          disabled: selectedArithmeticItemCount.value === null,
          action: 'create',
        }
      : null
  }
  const mapping: Partial<
    Record<
      WeeklyArithmeticBatchState,
      { label: string; disabled: boolean; action?: ArithmeticAction }
    >
  > = {
    preparing: { label: '正在准备口算…', disabled: true },
    ready: { label: '开始口算', disabled: false, action: 'start' },
    in_progress: { label: '继续口算', disabled: false, action: 'resume' },
    completed: { label: '再来一组', disabled: false, action: 'create' },
    failed_retryable: {
      label: `重试生成 ${selectedArithmeticItemCount.value ?? 0} 道`,
      disabled: false,
      action: 'retry',
    },
  }
  const state = mapping[batch.state]
  return state ? { ...state, batch_id: batch.batch_id } : null
}

function dispatchArithmetic(track: WeeklyPracticeTrackDTO) {
  const intent = arithmeticAction(track)
  if (!intent?.action || intent.disabled) return
  emit('arithmetic-action', {
    action: intent.action,
    ...(intent.action === 'create'
      ? { item_count: selectedArithmeticItemCount.value ?? undefined }
      : {}),
    ...(intent.batch_id ? { batch_id: intent.batch_id } : {}),
  })
}

function arithmeticFailure(track: WeeklyPracticeTrackDTO): string {
  if (track.plan_section !== 'arithmetic_warmup') return ''
  return track.arithmetic_batch?.failure_message ?? track.failure_message ?? ''
}
</script>

<template>
  <section class="weekly" aria-labelledby="weekly-title">
    <div v-if="loading" class="weekly__state" role="status">正在读取本周计划…</div>
    <div
      v-else-if="error"
      class="weekly__state weekly__state--error"
      role="alert"
      data-testid="weekly-practice-error"
    >
      <span>{{ error }}</span>
      <button type="button" class="btn btn-ghost" @click="emit('retry')">重试</button>
    </div>
    <template v-else-if="plan && settings">
      <div class="weekly-toolbar k12-secondary-toolbar">
        <K12BookTabs
          class="weekly-view-tabs"
          :model-value="activeTab"
          :tabs="weeklyViewTabs"
          label="本周该练视图"
          variant="secondary"
          @select="selectView"
        />
        <slot name="toolbar-actions" v-if="activeTab === 'current'" />
      </div>

      <template v-if="activeTab === 'current'">
        <div
          v-if="!progress"
          class="weekly-progress rc-week-progress weekly-progress--missing rc-week-progress--missing"
        >
          <div>
            <b>设置教材进度，推荐更贴合课堂</b>
          </div>
          <button
            type="button"
            class="btn btn-ghost"
            data-testid="setup-weekly-progress"
            @click="emit('open-progress')"
          >
            调整进度
          </button>
        </div>
        <div v-else class="weekly-progress rc-week-progress">
          <div>
            <b>当前教材进度</b>
            <span>{{ progressLabel }}</span>
          </div>
          <button type="button" class="btn btn-ghost" @click="emit('open-progress')">
            调整进度
          </button>
        </div>

        <div v-if="dueReviewCount === 0" class="weekly-no-mistakes" role="status">
          <b>本周暂时没有需要复习的错题</b>
          <span>可以根据当前教材进度做几道同步巩固，或者进行一次口算热身。</span>
        </div>

        <div class="weekly-hero rc-week-hero">
          <div class="weekly-hero__head">
            <div class="weekly-hero__count">
              <b>{{ totalCount }}</b
              ><span>项本周该练</span>
            </div>
            <div class="weekly-hero__meta">
              <span class="kpill">本周错题 {{ weeklyMistakeCount }}</span>
              <span class="kpill"
                >同步巩固
                {{
                  supplementLabel(
                    'textbook_consolidation',
                    textbookRecommendation,
                    verifiedItems(
                      visibleTracks.find(
                        (track) => track.plan_section === 'textbook_consolidation',
                      )!,
                    ).length,
                  )
                }}</span
              >
              <span class="kpill"
                >口算热身
                {{
                  supplementLabel(
                    'arithmetic_warmup',
                    arithmeticRecommendation,
                    verifiedItems(
                      visibleTracks.find((track) => track.plan_section === 'arithmetic_warmup')!,
                    ).length,
                  )
                }}</span
              >
            </div>
            <span v-if="trendPill" class="stpill got">趋势 ↑ 在进步</span>
            <div class="weekly-hero__context">
              <h2 id="weekly-title">本周该练</h2>
              <p>
                {{ monthDay(plan.local_start_date) }}–{{ monthDay(plan.local_end_date) }} ·
                {{ plan.iso_week_year }}年第{{ plan.iso_week_number }}周
              </p>
            </div>
          </div>
          <section
            v-for="track in visibleTracks"
            :key="track.plan_section"
            class="weekly-track rc-week-plan__section"
            :data-track="track.plan_section"
            :data-textbook-consolidation-state="
              track.plan_section === 'textbook_consolidation'
                ? textbookRecommendation?.availability
                : undefined
            "
            :data-arithmetic-state="
              track.plan_section === 'arithmetic_warmup'
                ? arithmeticRecommendation?.availability
                : undefined
            "
            :data-availability="
              track.plan_section === 'textbook_consolidation'
                ? textbookRecommendation?.availability
                : track.plan_section === 'arithmetic_warmup'
                  ? arithmeticRecommendation?.availability
                  : undefined
            "
          >
            <div class="weekly-track__head rc-week-plan__section-head">
              <div>
                <b>{{ sectionLabels[track.plan_section] }}</b>
                <span>{{ sectionDescriptions[track.plan_section] }}</span>
              </div>
            </div>

            <div
              v-if="track.plan_section !== 'arithmetic_warmup' && track.status === 'failed'"
              class="weekly-track__failure"
              role="status"
            >
              {{
                setupRequiredFor(track.plan_section)
                  ? setupRequiredMessage[track.plan_section]
                  : track.failure_message || '这一部分暂时无法生成，到期复习不受影响。'
              }}
            </div>
            <div v-if="arithmeticFailure(track)" class="weekly-track__failure" role="status">
              {{
                setupRequiredFor(track.plan_section)
                  ? setupRequiredMessage[track.plan_section]
                  : arithmeticFailure(track)
              }}
            </div>
            <button
              v-if="track.plan_section === 'textbook_consolidation' && track.status === 'stale'"
              type="button"
              class="btn weekly-track__action"
              :disabled="busy"
              @click="emit('refresh-textbook')"
            >
              按新进度更新
            </button>
            <button
              v-if="
                track.plan_section === 'textbook_consolidation' &&
                track.status === 'failed' &&
                (!textbookRecommendation ||
                  textbookRecommendation.availability === 'failed_retryable')
              "
              type="button"
              class="btn weekly-track__action"
              :disabled="
                busy ||
                (textbookRecommendation?.availability === 'failed_retryable' &&
                  selectedTextbookItemCount === null)
              "
              @click="
                textbookRecommendation?.availability === 'failed_retryable' &&
                selectedTextbookItemCount !== null
                  ? emit('prepare-textbook', { item_count: selectedTextbookItemCount })
                  : emit('refresh-textbook')
              "
            >
              {{
                textbookRecommendation?.availability === 'failed_retryable'
                  ? `重试生成 ${selectedTextbookItemCount ?? 0} 道`
                  : '重试'
              }}
            </button>
            <button
              v-if="
                arithmeticAction(track) && (track.arithmetic_batch || !arithmeticRecommendation)
              "
              type="button"
              class="btn weekly-track__action"
              :disabled="busy || arithmeticAction(track)?.disabled"
              @click="dispatchArithmetic(track)"
            >
              {{ arithmeticAction(track)?.label }}
            </button>

            <div class="weekly-resource-list">
              <div
                v-if="
                  track.plan_section === 'textbook_consolidation' &&
                  textbookRecommendation &&
                  verifiedItems(track).length === 0
                "
                class="weekly-manual resource-row"
              >
                <b>{{ compactProgressLabel || progressLabel || '请先确认当前教材进度' }}</b>
                <span class="weekly-manual__origin rc-practice-origin">
                  <b
                    >建议
                    {{
                      textbookRecommendation.recommended_item_count ??
                      selectedTextbookItemCount ??
                      0
                    }}
                    道</b
                  >
                  <small>按本周学习负担推荐，可直接调整题数</small>
                </span>
                <K12ManualQuestionCountField
                  v-model="selectedTextbookItemCount"
                  track="textbook_consolidation"
                  label="同步巩固题数"
                  :min="textbookRecommendation.min_item_count"
                  :max="textbookRecommendation.max_item_count"
                  :disabled="busy || textbookRecommendation.availability !== 'available'"
                />
                <button
                  v-if="
                    textbookRecommendation.availability === 'available' ||
                    textbookRecommendation.availability === 'processing'
                  "
                  type="button"
                  class="btn weekly-track__action"
                  data-consolidation-action
                  :disabled="
                    busy ||
                    textbookRecommendation.availability !== 'available' ||
                    selectedTextbookItemCount === null
                  "
                  @click="
                    selectedTextbookItemCount !== null &&
                    emit('prepare-textbook', { item_count: selectedTextbookItemCount })
                  "
                >
                  {{
                    textbookRecommendation.availability === 'processing'
                      ? `正在生成 ${selectedTextbookItemCount ?? 0} 道…`
                      : '生成同步巩固题'
                  }}
                </button>
              </div>
              <div
                v-if="
                  track.plan_section === 'arithmetic_warmup' &&
                  arithmeticRecommendation &&
                  !track.arithmetic_batch
                "
                class="weekly-manual resource-row"
              >
                <b>当前范围：分数、小数基础计算</b>
                <span class="weekly-manual__origin rc-practice-origin">
                  <b
                    >建议
                    {{
                      arithmeticRecommendation.recommended_item_count ??
                      selectedArithmeticItemCount ??
                      0
                    }}
                    道</b
                  >
                  <small>短时完成，可直接调整题数</small>
                </span>
                <K12ManualQuestionCountField
                  v-model="selectedArithmeticItemCount"
                  track="arithmetic_warmup"
                  label="口算热身题数"
                  :min="arithmeticRecommendation.min_item_count"
                  :max="arithmeticRecommendation.max_item_count"
                  :disabled="busy || arithmeticRecommendation.availability !== 'available'"
                />
                <button
                  v-if="arithmeticAction(track)"
                  type="button"
                  class="btn weekly-track__action"
                  data-arithmetic-action
                  :disabled="busy || arithmeticAction(track)?.disabled"
                  @click="dispatchArithmetic(track)"
                >
                  {{ arithmeticAction(track)?.label }}
                </button>
              </div>
              <div
                v-if="
                  track.status === 'disabled' &&
                  track.plan_section === 'due_review' &&
                  dueReviewCount > 0
                "
                class="weekly-track__empty"
              >
                尚未开启
              </div>
              <div
                v-else-if="
                  verifiedItems(track).length === 0 &&
                  track.plan_section === 'due_review' &&
                  dueReviewCount > 0 &&
                  track.status !== 'stale' &&
                  !arithmeticFailure(track)
                "
                class="weekly-track__empty"
              >
                这部分本周暂无需要练习的内容
              </div>
              <article
                v-for="item in verifiedItems(track)"
                :key="item.item_id"
                class="weekly-item resource-row"
              >
                <MarkdownRenderer class="weekly-item__prompt" :content="item.prompt_markdown" />
                <div class="weekly-item__origin rc-practice-origin">
                  <b>
                    {{ sectionLabels[item.plan_section] }} ·
                    {{ generationLabels[item.generation_method] || item.generation_method }}
                  </b>
                  <small>依据：{{ evidenceLabel(item) || '已通过服务端验证' }}</small>
                </div>
                <div
                  v-if="item.subject || item.knowledge_point || item.mastery_status"
                  class="weekly-item__meta"
                >
                  <span
                    v-if="item.subject || item.knowledge_point"
                    class="kpill"
                    :class="kpillSubjectClass(item.subject)"
                    >{{ item.subject || '' }}{{ item.subject && item.knowledge_point ? '·' : ''
                    }}{{ item.knowledge_point || '' }}</span
                  >
                  <span
                    v-if="masteryPill(item.mastery_status) && item.mastery_status !== 'retried'"
                    :class="['stpill', masteryPill(item.mastery_status)!.cls]"
                    >{{ masteryPill(item.mastery_status)!.label }}</span
                  >
                </div>
                <div class="weekly-item__foot">
                  <button
                    v-if="
                      track.plan_section === 'due_review' &&
                      practiceProjection(item).kind === 'action' &&
                      practiceProjection(item).action === 'join'
                    "
                    type="button"
                    class="btn"
                    :data-testid="`weekly-practice-${item.source_ref}`"
                    :disabled="busy || practiceGenerationBusy?.includes(item.source_ref)"
                    @click="emit('join-practice', item)"
                  >
                    {{ practiceProjection(item).label }}
                  </button>
                  <button
                    v-if="
                      track.plan_section === 'due_review' &&
                      practiceProjection(item).kind === 'pending'
                    "
                    type="button"
                    class="btn"
                    :data-testid="`weekly-practice-${item.source_ref}`"
                    disabled
                  >
                    {{ practiceProjection(item).label }}
                  </button>
                  <template
                    v-if="
                      track.plan_section === 'due_review' &&
                      practiceProjection(item).kind === 'joined'
                    "
                  >
                    <span
                      class="stpill got weekly-item__joined"
                      :data-testid="`weekly-practice-${item.source_ref}`"
                      >{{ practiceProjection(item).label }}</span
                    >
                    <button
                      type="button"
                      class="btn btn-ghost"
                      :data-testid="`weekly-view-practice-${item.source_ref}`"
                      @click="emit('view-practice', item)"
                    >
                      查看新题
                    </button>
                  </template>
                  <button
                    v-if="
                      track.plan_section === 'due_review' &&
                      practiceProjection(item).kind === 'action' &&
                      practiceProjection(item).action === 'retry'
                    "
                    type="button"
                    class="btn"
                    :data-testid="`weekly-practice-${item.source_ref}`"
                    :disabled="busy || practiceGenerationBusy?.includes(item.source_ref)"
                    @click="emit('retry-mistake-practice', item.source_ref)"
                  >
                    {{ practiceProjection(item).label }}
                  </button>
                  <button
                    v-if="track.plan_section === 'due_review'"
                    type="button"
                    class="btn btn-ghost weekly-item__defer"
                    :disabled="busy"
                    @click="emit('defer-item', item)"
                  >
                    本周先不练
                  </button>
                  <K12MistakeReviewMenu
                    v-if="track.plan_section === 'due_review'"
                    :suppressed="false"
                    :busy="busy"
                    @suppress="emit('suppress-item', item)"
                  />
                </div>
              </article>
            </div>
          </section>
          <p v-if="activeTab === 'current'" class="weekly-lifecycle rc-week-hero__foot">
            <span class="note"
              >每周五 19:00 自动整理本周错题 · 同步巩固和口算热身按需准备 · 不自动加入练习集</span
            >
          </p>
        </div>
      </template>

      <section v-else class="weekly-history" role="tabpanel" aria-label="历史周练">
        <div class="weekly-history__list resource-list">
          <article
            v-for="item in history"
            :key="item.snapshot_id"
            class="weekly-history__card resource-row k12-week-history-card"
          >
            <b>{{ archiveDateLabel(item) }}</b>
            <span class="weekly-history__origin rc-practice-origin">
              <b>{{ archiveWeekLabel(item) }}</b>
              <small>{{ archiveResultLabel(item) }}</small>
            </span>
            <span class="stpill got">已归档</span>
            <button type="button" class="btn" @click="openHistory(item)">查看周练</button>
          </article>
        </div>
        <div v-if="!history.length" class="weekly-track__empty">暂无历史周练</div>
      </section>

      <Teleport to="body">
        <div
          v-if="historyDetail"
          class="weekly-history-dialog__overlay"
          @click.self="historyDetail = null"
        >
          <section
            class="weekly-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="历史周练详情"
          >
            <header>
              <div>
                <b>{{ archiveDateLabel(historyDetail) }}</b>
                <span>{{ archiveWeekLabel(historyDetail) }}</span>
              </div>
              <button type="button" aria-label="关闭" @click="historyDetail = null">×</button>
            </header>
            <p>{{ archiveResultLabel(historyDetail) }} · 已归档</p>
            <div class="weekly-history-dialog__actions">
              <button
                v-for="action in [
                  { value: 'print', label: '打印' },
                  { value: 'send_im', label: '发送到手机' },
                ]"
                :key="action.value"
                type="button"
                class="btn"
                @click="
                  emit('history-artifact-action', {
                    action: action.value as 'print' | 'send_im',
                    snapshot_id: historyDetail.snapshot_id,
                    artifact_id: historyDetail.artifact_id,
                  })
                "
              >
                {{ action.label }}
              </button>
              <button
                type="button"
                class="btn"
                @click="emit('history-insights', historyDetail.snapshot_id)"
              >
                查看对应学情
              </button>
            </div>
          </section>
        </div>
      </Teleport>
    </template>
    <div v-else class="weekly__state">当前周尚无计划</div>
  </section>
</template>

<style scoped>
.weekly {
  display: grid;
  gap: 14px;
}
.weekly__state,
.weekly-track__failure,
.weekly-track__empty {
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  padding: 14px;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-card);
}
.weekly__state--error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--hc-error);
}
.weekly-view-tabs {
  width: auto;
  flex: 1 1 auto;
}
.weekly-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 15px;
  border: 0.5px solid color-mix(in srgb, var(--hc-accent) 38%, var(--hc-border));
  border-radius: 13px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--hc-accent) 8%, transparent), transparent 65%),
    var(--hc-bg-card);
}
.weekly-no-mistakes {
  display: grid;
  gap: 4px;
  padding: 13px 15px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
}
.weekly-no-mistakes b {
  color: var(--hc-text-primary);
}
.weekly-manual {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
}
.weekly-manual > b {
  flex: 0 0 250px;
  min-width: 0;
  overflow: hidden;
  color: var(--hc-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1100px) {
  .weekly-manual {
    flex-wrap: wrap;
  }
  .weekly-manual > b {
    flex: 1 1 220px;
  }
}
.weekly-progress--missing {
  border-style: dashed;
}
.weekly-progress > div {
  display: grid;
  gap: 4px;
}
.weekly-item__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.kpill {
  font-size: 10.5px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  border-radius: 4px;
  padding: 2px 7px;
  font-weight: 650;
  white-space: nowrap;
}
.kpill--chi {
  background: color-mix(in srgb, #e8590c 12%, transparent);
  color: #e8590c;
}
.kpill--eng {
  background: color-mix(in srgb, #7048e8 10%, transparent);
  color: #7048e8;
}
.kpill--sci {
  background: color-mix(in srgb, #2b8a3e 11%, transparent);
  color: #2b8a3e;
}
.kpill--it {
  background: color-mix(in srgb, #0b7285 11%, transparent);
  color: #0b7285;
}
.stpill {
  font-size: 10.5px;
  border-radius: 999px;
  padding: 2px 9px;
  font-weight: 700;
  white-space: nowrap;
}
.stpill.todo {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}
.stpill.done {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
}
.stpill.got {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}

.weekly-progress b {
  font-size: 13.5px;
}
.weekly-progress span,
.weekly-progress small {
  color: var(--hc-text-secondary);
  line-height: 1.5;
}

.weekly-hero {
  overflow: visible;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background:
    radial-gradient(
      circle at 90% 0%,
      color-mix(in srgb, var(--hc-accent) 18%, transparent),
      transparent 36%
    ),
    var(--hc-bg-card);
}
.weekly-hero__head,
.weekly-hero__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 17px;
}
.weekly-hero__head {
  justify-content: space-between;
}
.weekly-hero h2,
.weekly-hero p {
  margin: 0;
}
.weekly-hero h2 {
  font-size: 18px;
}
.weekly-hero p {
  margin-top: 4px;
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.weekly-hero__count {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.weekly-hero__count b {
  font-size: 27px;
  font-variant-numeric: tabular-nums;
}
.weekly-hero__count span {
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.weekly-hero__meta {
  padding-top: 0;
  flex-wrap: wrap;
}
.weekly-hero__meta span {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}
.weekly-track {
  display: grid;
  gap: 9px;
}
.weekly-track__head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  padding: 0 2px;
}
.weekly-track__head > div {
  display: grid;
  gap: 2px;
}
.weekly-track__head b {
  font-size: 14px;
}
.weekly-track__head span {
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}
.weekly-track__failure {
  color: var(--hc-warning, #9a5b00);
}
.weekly-track__action {
  width: fit-content;
}
.weekly-item {
  display: grid;
  gap: 8px;
  padding: 13px 15px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
}
.weekly-item__origin {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.weekly-item__origin b {
  font-size: 12px;
  color: var(--hc-accent);
}
.weekly-item__origin span,
.weekly-item small {
  color: var(--hc-text-muted);
  font-size: 11.5px;
}
.weekly-item__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.weekly-item__defer {
  flex: 0 0 auto;
}
.weekly-item__prompt :deep(.markdown-body) {
  margin: 0;
}
.weekly-history {
  display: block;
}
.weekly-history__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.weekly-history__card {
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
  line-height: 18px;
}
.weekly-history__card > b {
  min-width: 0;
  color: var(--hc-text-primary);
}
.weekly-history__origin {
  display: grid;
  gap: 1px;
  min-width: 160px;
}
.weekly-history__origin b {
  color: var(--hc-text-secondary);
  font-size: 11px;
}
.weekly-history__origin small {
  overflow: hidden;
  color: var(--hc-text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.weekly-history-dialog__overlay {
  position: fixed;
  z-index: var(--hc-z-modal, 9100);
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(8, 18, 32, 0.4);
}
.weekly-history-dialog {
  width: min(560px, calc(100vw - 32px));
  padding: 18px;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}
.weekly-history-dialog header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.weekly-history-dialog header > div {
  display: grid;
  gap: 3px;
}
.weekly-history-dialog header span {
  color: var(--hc-text-secondary);
}
.weekly-history-dialog header button {
  border: 0;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
}
.weekly-history-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
@media (max-width: 680px) {
  .weekly-progress,
  .weekly-hero__head,
  .weekly-item__origin {
    align-items: flex-start;
    flex-direction: column;
  }
}

/* Approved learning-record fidelity contract: period tabs, artifact actions and
   generated tracks share one compact weekly workspace. */
.weekly {
  display: block;
  gap: 0;
}

.weekly-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.weekly-toolbar :slotted(.k12rec__weekly-actions) {
  margin-left: auto;
}

.weekly-progress {
  min-height: 46px;
  margin-bottom: 12px;
  padding: 9px 13px;
  border-radius: 12px;
  background: var(--hc-bg-card);
  box-shadow: none;
}

.weekly-progress > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
}

.weekly-progress > div > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weekly-progress > button {
  font-family: inherit;
  line-height: 18px;
}

.weekly-progress--missing {
  border-style: dashed;
  background: var(--hc-bg-card);
}

/* BUG-20260818-002：缺教材进度提示卡与已设置卡一致单行（2026-08-18 用户决定，
   取代 BUG-20260815-001 的纵向堆叠）：标题一行 + 调整进度按钮一行。 */
.weekly-progress--missing > div > b {
  white-space: nowrap;
  flex: none;
}
.weekly-progress--missing > button {
  flex: none;
  white-space: nowrap;
}

.weekly-hero {
  margin: 0;
  border-bottom: 0;
  border-radius: 16px 16px 0 0;
  box-shadow: none;
}

.weekly-track {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 12px 16px 14px;
  border-right: 0.5px solid var(--hc-border);
  border-left: 0.5px solid var(--hc-border);
  background: var(--hc-bg-card);
}

.weekly-track + .weekly-track {
  padding-top: 6px;
}

.weekly-item {
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) minmax(150px, 0.9fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 54px;
  padding: 9px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-elevated);
  box-shadow: none;
}

.weekly-lifecycle {
  margin: 0;
  padding: 11px 16px 13px;
  border: 0.5px solid var(--hc-border);
  border-top: 0;
  border-radius: 0 0 16px 16px;
  background: var(--hc-bg-card);
  color: var(--hc-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

@media (max-width: 960px) {
  .weekly-item {
    grid-template-columns: minmax(0, 1fr);
    gap: 7px;
  }
}

/* 本周该练按权威原型收敛为单一 hero：轨道、题目行和生命周期说明属于同一计划容器。 */
.weekly-toolbar.k12-secondary-toolbar {
  margin-bottom: 12px;
}

.weekly-progress.rc-week-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  gap: 16px;
  height: 52px;
  min-height: 52px;
  margin: 0 0 12px;
  padding: 9px 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: rgba(255, 254, 249, 0.9);
  box-shadow: none;
}

.weekly-progress.rc-week-progress > div {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex-wrap: wrap;
}

.weekly-progress.rc-week-progress b {
  font-size: 12px;
  white-space: nowrap;
}

.weekly-progress.rc-week-progress span {
  min-width: 0;
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.weekly-progress.rc-week-progress > button {
  /* 进度条动作复用全局 .btn.btn-ghost 的字体/高度，避免 WebKit 与原型漂移。 */
  flex: none;
  white-space: nowrap;
}

.weekly-progress.rc-week-progress--missing {
  flex-direction: row;
  background: var(--hc-bg-input);
}

.weekly-hero.rc-week-hero {
  display: block;
  overflow: visible;
  margin: 2px 0 14px;
  padding: 18px 18px 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: linear-gradient(160deg, var(--hc-accent-subtle), rgba(255, 254, 249, 0.9) 55%);
  box-shadow: var(--hc-shadow-sm);
}

.weekly-hero.rc-week-hero .weekly-hero__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 14px;
  padding: 0;
}

.weekly-hero.rc-week-hero .weekly-hero__head > div:first-child {
  min-width: 0;
}

.weekly-hero.rc-week-hero .weekly-hero__count {
  gap: 7px;
  margin-left: 0;
}

.weekly-hero.rc-week-hero .weekly-hero__count b {
  color: var(--hc-text-primary);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1;
}

.weekly-hero.rc-week-hero .weekly-hero__count span {
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.weekly-hero.rc-week-hero .weekly-hero__meta > .kpill {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 1.5;
}

.weekly-hero.rc-week-hero .weekly-hero__meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
}

.weekly-hero.rc-week-hero .weekly-hero__context {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.weekly-hero.rc-week-hero .weekly-track.rc-week-plan__section {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.weekly-hero.rc-week-hero .weekly-resource-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.weekly-hero.rc-week-hero
  .weekly-track.rc-week-plan__section
  + .weekly-track.rc-week-plan__section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--hc-divider);
}

.weekly-hero.rc-week-hero .weekly-track__head.rc-week-plan__section-head {
  align-items: baseline;
  gap: 8px;
  margin: 0 0 7px;
  padding: 0;
}

.weekly-hero.rc-week-hero .weekly-track__head > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.weekly-hero.rc-week-hero .weekly-track__head b {
  font-size: 13px;
}

.weekly-hero.rc-week-hero .weekly-track__head span {
  min-width: 0;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.weekly-item.resource-row,
.weekly-manual.resource-row {
  display: flex;
  grid-template-columns: none;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 54.5px;
  padding: 10px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: rgba(255, 254, 249, 0.9);
  box-shadow: none;
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.weekly-item.resource-row .weekly-item__prompt {
  flex: 0 0 250px;
  min-width: 0;
  overflow: hidden;
}

.weekly-item.resource-row .weekly-item__prompt :deep(.markdown-body) {
  margin: 0;
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weekly-item.resource-row .kpill,
.weekly-item.resource-row .stpill {
  line-height: 1.5;
}

.weekly-item.resource-row .weekly-item__origin {
  display: grid;
  flex: 0 0 178px;
  gap: 1px;
  min-width: 178px;
}

.weekly-item.resource-row .weekly-item__origin b {
  min-width: 0;
  color: var(--hc-text-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weekly-item.resource-row .weekly-item__origin small {
  min-width: 0;
  color: var(--hc-text-muted);
  font-size: 10px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weekly-item.resource-row .weekly-item__meta,
.weekly-item.resource-row .weekly-item__foot {
  display: contents;
}

.weekly-item.resource-row .weekly-item__defer {
  flex: none;
}

.weekly-item.resource-row .btn,
.weekly-manual.resource-row .btn {
  flex: none;
}

.weekly-manual.resource-row {
  flex-wrap: wrap;
  justify-content: flex-start;
}

.weekly-manual.resource-row > b {
  flex: 0 0 250px;
  min-width: 0;
}

.weekly-manual.resource-row .weekly-manual__origin {
  display: grid;
  flex: 0 0 178px;
  gap: 1px;
  min-width: 178px;
}

.weekly-manual.resource-row .weekly-manual__origin b {
  min-width: 0;
  color: var(--hc-text-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weekly-manual.resource-row .weekly-manual__origin small {
  min-width: 0;
  color: var(--hc-text-muted);
  font-size: 10px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weekly-hero.rc-week-hero .weekly-lifecycle.rc-week-hero__foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 5px 20px;
  flex-wrap: wrap;
  margin: 12px 0 0;
  padding: 11px 0 0;
  padding-bottom: 0;
  border-top: 0.5px solid var(--hc-divider);
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  border-radius: 0;
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 14px;
  line-height: 21px;
}

@supports (font: -apple-system-body) {
  /* WebKit 使用同引擎原型的自然高度，Chromium 已通过的几何保持不变。 */
  .weekly-progress.rc-week-progress {
    height: 50px;
    min-height: 50px;
  }

  .weekly-item.resource-row {
    min-height: 53.5px;
  }
}

@media (max-width: 1040px) {
  .weekly-item.resource-row {
    flex-wrap: wrap;
    overflow: hidden;
  }

  .weekly-item.resource-row .weekly-item__prompt {
    flex: 1 1 180px;
  }

  .weekly-item.resource-row .weekly-item__origin {
    flex: 1 1 178px;
  }
}
</style>
