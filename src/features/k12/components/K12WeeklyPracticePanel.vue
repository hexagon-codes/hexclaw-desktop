<script setup lang="ts">
import { computed } from 'vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type {
  CurriculumProgressDTO,
  WeeklyPracticeHistorySummaryDTO,
  WeeklyPracticeItemDTO,
  WeeklyPracticePlanDTO,
  WeeklyPracticePrepareOutputResp,
  WeeklyPracticeSection,
  WeeklyPracticeSettingsDTO,
  WeeklyPracticeTrackDTO,
} from '@/api/k12'
import FinalArtifactActions from './FinalArtifactActions.vue'

const props = defineProps<{
  progress: CurriculumProgressDTO | null
  settings: WeeklyPracticeSettingsDTO | null
  plan: WeeklyPracticePlanDTO | null
  history: WeeklyPracticeHistorySummaryDTO[]
  output?: WeeklyPracticePrepareOutputResp | null
  loading?: boolean
  busy?: boolean
  error?: string
  deliveryLabel?: string
  deliveryDisabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-progress', options: { enableTextbookConsolidation: true }): void
  (e: 'retry'): void
  (e: 'prepare-output'): void
  (
    e: 'artifact-action',
    intent: { action: 'print' | 'export_pdf' | 'send_im'; artifact_digest: string },
  ): void
  (e: 'save-to-practice-set'): void
}>()

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
  learned_scope: '已学运算范围',
}

const visibleTracks = computed(() => {
  const tracks = props.plan?.tracks ?? []
  return tracks.filter((track) => {
    if (track.plan_section === 'due_review') return true
    if (track.plan_section === 'textbook_consolidation') {
      return props.settings?.textbook_consolidation_enabled === true
    }
    return props.settings?.arithmetic_warmup_enabled === true
  })
})

const verifiedItems = (track: WeeklyPracticeTrackDTO) =>
  track.items
    .filter((item) => item.verification.status === 'verified')
    .sort((left, right) => left.position - right.position)

const totalCount = computed(() =>
  visibleTracks.value.reduce((sum, track) => sum + verifiedItems(track).length, 0),
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

function archiveLabel(item: WeeklyPracticeHistorySummaryDTO): string {
  return `${monthDay(item.local_start_date)}–${monthDay(item.local_end_date)} · ${item.iso_week_year}年第${item.iso_week_number}周`
}
</script>

<template>
  <section class="weekly" aria-labelledby="weekly-title">
    <div v-if="loading" class="weekly__state" role="status">正在读取本周计划…</div>
    <div v-else-if="error" class="weekly__state weekly__state--error" role="alert" data-testid="weekly-practice-error">
      <span>{{ error }}</span>
      <button type="button" class="btn btn-ghost" @click="emit('retry')">重试</button>
    </div>
    <template v-else-if="plan && settings">
      <div v-if="!progress" class="weekly-progress weekly-progress--missing">
        <div>
          <b>设置教材进度，推荐更贴合课堂</b>
          <span>确认当前教材、单元和页码后，系统会补充与课堂同步的练习。错题巩固不受影响。</span>
        </div>
        <button
          type="button"
          class="btn"
          data-testid="setup-weekly-progress"
          @click="emit('open-progress', { enableTextbookConsolidation: true })"
        >
          设置进度并开启同步练习…
        </button>
      </div>
      <div v-else class="weekly-progress">
        <div>
          <b>当前教材进度</b>
          <span>{{ progressLabel }}</span>
          <small>
            同步巩固{{ settings.textbook_consolidation_enabled ? '已开启' : '未开启' }}
            · 口算热身{{ settings.arithmetic_warmup_enabled ? '已开启' : '未开启' }}
          </small>
        </div>
        <button
          type="button"
          class="btn btn-ghost"
          @click="emit('open-progress', { enableTextbookConsolidation: true })"
        >
          调整…
        </button>
      </div>

      <div class="weekly-hero">
        <div class="weekly-hero__head">
          <div>
            <h2 id="weekly-title">本周该练</h2>
            <p>{{ monthDay(plan.local_start_date) }}–{{ monthDay(plan.local_end_date) }} · {{ plan.iso_week_year }}年第{{ plan.iso_week_number }}周</p>
          </div>
          <div class="weekly-hero__count"><b>{{ totalCount }}</b><span>项本周该练</span></div>
        </div>
        <div class="weekly-hero__meta">
          <span v-for="track in visibleTracks" :key="track.plan_section">
            {{ sectionLabels[track.plan_section] }} {{ verifiedItems(track).length }}
          </span>
        </div>
        <div class="weekly-hero__foot">
          <template v-if="output">
            <FinalArtifactActions
              :artifact-digest="output.snapshot.snapshot_digest"
              @intent="emit('artifact-action', $event)"
            />
            <span v-if="deliveryLabel" class="weekly__delivery">{{ deliveryLabel }}</span>
            <button
              type="button"
              class="btn btn-ghost"
              data-testid="save-weekly-practice-set"
              :disabled="busy"
              @click="emit('save-to-practice-set')"
            >
              保存到练习集
            </button>
          </template>
          <button
            v-else
            type="button"
            class="btn btn-primary"
            data-testid="prepare-weekly-output"
            :disabled="busy || totalCount === 0"
            @click="emit('prepare-output')"
          >
            生成本周该练
          </button>
          <small>生成或输出不会自动加入练习集，也不会标记完成、掌握或错题。</small>
        </div>
      </div>

      <section
        v-for="track in visibleTracks"
        :key="track.plan_section"
        class="weekly-track"
        :data-track="track.plan_section"
      >
        <div class="weekly-track__head">
          <div>
            <b>{{ sectionLabels[track.plan_section] }}</b>
            <span>{{ sectionDescriptions[track.plan_section] }}</span>
          </div>
          <span>{{ verifiedItems(track).length }} 项</span>
        </div>
        <div v-if="track.status === 'failed'" class="weekly-track__failure" role="status">
          {{ track.failure_message || '这一部分暂时无法生成，到期复习不受影响。' }}
        </div>
        <div v-else-if="track.status === 'disabled'" class="weekly-track__empty">尚未开启</div>
        <div v-else-if="verifiedItems(track).length === 0" class="weekly-track__empty">
          这部分本周暂无需要练习的内容
        </div>
        <article
          v-for="item in verifiedItems(track)"
          :key="item.item_id"
          class="weekly-item"
        >
          <div class="weekly-item__origin">
            <b>{{ sectionLabels[item.plan_section] }} · {{ generationLabels[item.generation_method] }}</b>
            <span>来源：{{ sourceLabels[item.source_kind] || item.source_kind }}</span>
          </div>
          <MarkdownRenderer class="weekly-item__prompt" :content="item.prompt_markdown" />
          <small>依据：{{ evidenceLabel(item) || '已通过服务端验证' }}</small>
        </article>
      </section>

      <section v-if="history.length" class="weekly-history" aria-label="往期周练">
        <b>往期周练</b>
        <div v-for="item in history" :key="item.snapshot_id" class="weekly-history__row">
          <span>{{ archiveLabel(item) }}</span>
          <small>{{ item.item_count }} 项</small>
        </div>
      </section>
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
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background:
    radial-gradient(circle at 90% 0%, color-mix(in srgb, var(--hc-accent) 18%, transparent), transparent 36%),
    var(--hc-bg-card);
}
.weekly-hero__head,
.weekly-hero__meta,
.weekly-hero__foot {
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
.weekly-hero__foot {
  flex-wrap: wrap;
  border-top: 0.5px solid var(--hc-border);
}
.weekly-hero__foot small {
  flex-basis: 100%;
  color: var(--hc-text-muted);
}
.weekly__delivery {
  color: var(--hc-text-secondary);
  font-size: 12px;
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
.weekly-item__prompt :deep(.markdown-body) {
  margin: 0;
}
.weekly-history {
  display: grid;
  gap: 7px;
  padding-top: 4px;
}
.weekly-history__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
}
@media (max-width: 680px) {
  .weekly-progress,
  .weekly-hero__head,
  .weekly-item__origin {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
