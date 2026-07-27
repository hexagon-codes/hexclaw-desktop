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
}>()

type ArithmeticAction = 'create' | 'start' | 'resume' | 'retry'

const emit = defineEmits<{
  (e: 'open-progress'): void
  (e: 'retry'): void
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

function failedMistakePractice(item: WeeklyPracticeItemDTO) {
  return (
    item.source_kind === 'mistake' &&
    props.practiceGenerationByMistake?.[item.source_ref]?.state === 'failed'
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
  textbook_consolidation: '只补充已确认教材进度内的内容',
  arithmetic_warmup: '只练已经学过的运算，短时完成',
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
    .filter((item) => item.verification.status === 'verified')
    .sort((left, right) => left.position - right.position)

const totalCount = computed(() =>
  visibleTracks.value.reduce((sum, track) => sum + verifiedItems(track).length, 0),
)
const dueReviewCount = computed(
  () =>
    verifiedItems(
      visibleTracks.value.find((track) => track.plan_section === 'due_review')!,
    ).length,
)
const textbookRecommendation = computed(
  () => props.plan?.manual_track_recommendations?.textbook_consolidation,
)
const arithmeticRecommendation = computed(
  () => props.plan?.manual_track_recommendations?.arithmetic_warmup,
)

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

const progressLabel = computed(() => {
  const progress = props.progress
  if (!progress) return ''
  const parts = [
    progress.textbook_edition,
    progress.volume,
    progress.unit_title,
    progress.lesson_title,
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
      <K12BookTabs
        class="weekly-view-tabs"
        :model-value="activeTab"
        :tabs="weeklyViewTabs"
        label="本周该练视图"
        @select="selectView"
      />

      <template v-if="activeTab === 'current'">
        <div v-if="!progress" class="weekly-progress weekly-progress--missing">
          <div>
            <b>设置教材进度，推荐更贴合课堂</b>
            <span>确认当前教材、单元和页码后，系统会补充与课堂同步的练习。错题巩固不受影响。</span>
          </div>
          <button
            type="button"
            class="btn btn-ghost"
            data-testid="setup-weekly-progress"
            @click="emit('open-progress')"
          >
            设置教材进度
          </button>
        </div>
        <div v-else class="weekly-progress">
          <div>
            <b>当前教材进度</b>
            <span>{{ progressLabel }}</span>
            <small>同步巩固与口算热身可按需准备</small>
          </div>
          <button
            type="button"
            class="btn btn-ghost"
            @click="emit('open-progress')"
          >
            调整进度
          </button>
        </div>

        <div v-if="dueReviewCount === 0" class="weekly-no-mistakes" role="status">
          <b>本周暂时没有需要复习的错题</b>
          <span>可以根据当前教材进度做几道同步巩固，或者进行一次口算热身。</span>
        </div>

        <div class="weekly-hero">
          <div class="weekly-hero__head">
            <div>
              <h2 id="weekly-title">本周该练</h2>
              <p>
                {{ monthDay(plan.local_start_date) }}–{{ monthDay(plan.local_end_date) }} ·
                {{ plan.iso_week_year }}年第{{ plan.iso_week_number }}周
              </p>
            </div>
            <div class="weekly-hero__count">
              <b>{{ totalCount }}</b><span>项本周该练</span>
            </div>
          </div>
          <div class="weekly-hero__meta">
            <span v-for="track in visibleTracks" :key="track.plan_section">
              {{ sectionLabels[track.plan_section] }} {{ verifiedItems(track).length }}
            </span>
          </div>
        </div>

        <section
          v-for="track in visibleTracks"
          :key="track.plan_section"
          class="weekly-track"
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
          <div class="weekly-track__head">
            <div>
              <b>{{ sectionLabels[track.plan_section] }}</b>
              <span>{{ sectionDescriptions[track.plan_section] }}</span>
            </div>
            <span>{{ verifiedItems(track).length }} 项</span>
          </div>

          <div
            v-if="
              track.plan_section !== 'arithmetic_warmup' &&
              track.status === 'failed'
            "
            class="weekly-track__failure"
            role="status"
          >
            {{ track.failure_message || '这一部分暂时无法生成，到期复习不受影响。' }}
          </div>
          <div
            v-if="arithmeticFailure(track)"
            class="weekly-track__failure"
            role="status"
          >
            {{ arithmeticFailure(track) }}
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
              arithmeticAction(track) &&
              (track.arithmetic_batch || !arithmeticRecommendation)
            "
            type="button"
            class="btn weekly-track__action"
            :disabled="busy || arithmeticAction(track)?.disabled"
            @click="dispatchArithmetic(track)"
          >
            {{ arithmeticAction(track)?.label }}
          </button>

          <div
            v-if="
              track.plan_section === 'textbook_consolidation' &&
              textbookRecommendation &&
              verifiedItems(track).length === 0
            "
            class="weekly-manual"
          >
            <b>{{ progressLabel || '请先确认当前教材进度' }}</b>
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
            class="weekly-manual"
          >
            <b>当前范围：已确认教材进度内的基础计算</b>
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
            class="weekly-item"
          >
            <div class="weekly-item__origin">
              <b>
                {{ sectionLabels[item.plan_section] }} ·
                {{ generationLabels[item.generation_method] || item.generation_method }}
              </b>
              <span>来源：{{ sourceLabels[item.source_kind] || item.source_kind }}</span>
            </div>
            <MarkdownRenderer class="weekly-item__prompt" :content="item.prompt_markdown" />
            <div class="weekly-item__foot">
              <small>依据：{{ evidenceLabel(item) || '已通过服务端验证' }}</small>
              <button
                v-if="track.plan_section === 'due_review' && failedMistakePractice(item)"
                type="button"
                class="btn"
                :data-testid="`weekly-practice-${item.source_ref}`"
                :disabled="busy || practiceGenerationBusy?.includes(item.source_ref)"
                @click="emit('retry-mistake-practice', item.source_ref)"
              >
                出题失败 · 重试
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
                display="visible"
                @suppress="emit('suppress-item', item)"
              />
            </div>
          </article>
        </section>
      </template>

      <section v-else class="weekly-history" role="tabpanel" aria-label="历史周练">
        <article
          v-for="item in history"
          :key="item.snapshot_id"
          class="weekly-history__card"
        >
          <div>
            <b>{{ archiveDateLabel(item) }}</b>
            <span>{{ archiveWeekLabel(item) }}</span>
            <p>{{ archiveResultLabel(item) }}</p>
          </div>
          <span>已归档</span>
          <button type="button" class="btn" @click="openHistory(item)">查看周练</button>
        </article>
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
  width: fit-content;
  flex: none;
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
    radial-gradient(circle at 90% 0%, color-mix(in srgb, var(--hc-accent) 18%, transparent), transparent 36%),
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
  display: grid;
  gap: 10px;
}
.weekly-history__card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
}
.weekly-history__card > div {
  display: grid;
  gap: 3px;
}
.weekly-history__card p {
  margin: 2px 0 0;
  color: var(--hc-text-secondary);
}
.weekly-history__card span {
  color: var(--hc-text-muted);
  font-size: 12px;
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
  .weekly-history__card {
    grid-template-columns: 1fr;
  }
}
</style>
