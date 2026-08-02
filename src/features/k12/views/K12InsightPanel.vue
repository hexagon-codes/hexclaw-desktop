<!--
  K12 学情面板（PRD §3.11）· IA 定稿后为顶栏一等 Tab（辅导｜学习档案｜学情）。
  真实 /insight-report（趋势/薄弱 TOP3/连续挫败/建议）；不展示辅导次数/学习时长
  （架构设计 v0.5.0《明确不做》#6，§5.7 派生指标口径表内无「辅导次数」）。
  从 K12RecordsView 学情二级 Tab 抽出（2026-07-18 IA 迁移）；数据仍走 useK12Store 单一事实源。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useK12Store } from '../store'
import type {
  K12MistakeStatusFilter,
  K12RecordsNavigation,
  K12RecordsTarget,
} from '../records-navigation'

const props = defineProps<{
  agentId: string
  /** 年级（k12.grade_term，K12ChatEnhancement 透传）：标题「{grade}学习概览」；缺省用通用文案 */
  grade?: string
}>()
const emit = defineEmits<{
  /** 学情=路由器（§3.11）：精确携带对象/学科/状态，非目标维度显式清为全部。 */
  (e: 'navigate', navigation: K12RecordsNavigation): void
}>()
const { t } = useI18n()
const store = useK12Store()
const loading = ref(false)
let reloadRequest = 0

// AP-027 IME 守卫：这些是 role="button" 键盘激活出口，组字中的回车（isComposing）不应触发跳转。
function navigation(
  target: K12RecordsTarget,
  subject = '',
  status: K12MistakeStatusFilter = 'all',
): K12RecordsNavigation {
  return { target, subject, status }
}

const onNavKey = (e: KeyboardEvent, destination: K12RecordsNavigation) => {
  if (e.isComposing || e.keyCode === 229) return
  emit('navigate', destination)
}

async function reload() {
  const agentId = props.agentId
  const request = ++reloadRequest
  if (!agentId) {
    loading.value = false
    return
  }
  loading.value = true
  await store.loadReport(agentId)
  if (request === reloadRequest) loading.value = false
}
onMounted(reload)
watch(() => props.agentId, reload)

const report = computed(() => store.report)
const reportGrade = computed(() => report.value?.grade_term || props.grade)
const weekPending = computed(() => report.value?.week_pending ?? null)
const practicePending = computed(() => report.value?.practice_pending ?? null)
const errorMessage = computed(() => store.reportError ?? '')
const hasInsightData = computed(() =>
  Boolean(
    report.value &&
    (report.value.trend.total > 0 ||
      report.value.weak_top3.length > 0 ||
      (report.value.consecutive_fail_kps?.length ?? 0) > 0 ||
      (weekPending.value ?? 0) > 0 ||
      (practicePending.value ?? 0) > 0),
  ),
)

// 薄弱知识点比例由服务端同一快照的 month_new_mistakes 冻结计算；前端不再
// 用本周队列或第二份错题列表重算。
const weakBars = computed(() => {
  const list = report.value?.weak_top3 ?? []
  const monthTotal = report.value?.month_new_mistakes ?? 0
  return list.map((w) => ({
    name: w.knowledge_point,
    count: w.count,
    pct: Math.min(
      100,
      Math.max(
        0,
        Math.round(
          (Number.isFinite(w.share) ? w.share : monthTotal > 0 ? w.count / monthTotal : 0) * 100,
        ),
      ),
    ),
    subject: w.subject ?? '',
  }))
})
</script>

<template>
  <section class="k12ins" data-testid="insight-panel">
    <div class="k12ins__head">
      <!-- app.html:2352：「{grade}学习概览 · 从真实批改与复练证据生成」 -->
      <h2 class="k12ins__h" style="margin: 0" data-testid="insight-title">
        {{
          reportGrade
            ? t('k12.report.titleWithGrade', { grade: reportGrade })
            : t('k12.report.title')
        }}
      </h2>
      <span class="k12ins__hint" style="margin: 0">{{ t('k12.report.monthlyNote') }}</span>
    </div>
    <div
      v-if="loading"
      class="k12ins__state"
      role="status"
      aria-live="polite"
      data-testid="insight-loading"
    >
      {{ t('k12.report.loading') }}
    </div>
    <div v-else-if="errorMessage" class="k12ins__error" role="alert" data-testid="insight-error">
      <span>{{ errorMessage }}</span>
      <button data-testid="insight-retry" @click="reload">{{ t('common.retry') }}</button>
    </div>
    <template v-else-if="report && hasInsightData">
      <!-- 原型 app.html:2354：四块均是档案路由器，数字与单位分层。 -->
      <div class="k12ins__tiles" style="margin-top: 12px">
        <div
          class="k12ins__tile"
          role="button"
          tabindex="0"
          data-testid="insight-tile-semester"
          @click="emit('navigate', navigation('mistakes'))"
          @keydown.enter="onNavKey($event, navigation('mistakes'))"
        >
          <b
            ><span>{{ report.trend.total }}</span
            ><em>{{ t('k12.report.unitItems') }}</em></b
          >{{ t('k12.report.tiles.semesterMistakes') }}
        </div>
        <div
          class="k12ins__tile"
          role="button"
          tabindex="0"
          data-testid="insight-tile-mastered"
          @click="emit('navigate', navigation('mistakes', '', 'mastered'))"
          @keydown.enter="onNavKey($event, navigation('mistakes', '', 'mastered'))"
        >
          <b
            ><span>{{ report.trend.mastered }}</span
            ><em>{{ t('k12.report.unitItems') }}</em></b
          >{{ t('k12.report.tiles.mastered') }}
        </div>
        <div
          class="k12ins__tile"
          role="button"
          tabindex="0"
          data-testid="insight-tile-week"
          @click="emit('navigate', navigation('week'))"
          @keydown.enter="onNavKey($event, navigation('week'))"
        >
          <b
            ><span>{{ weekPending ?? '—' }}</span
            ><em v-if="weekPending != null">{{ t('k12.report.unitItems') }}</em></b
          >{{ t('k12.report.tiles.weekPending') }}
        </div>
        <div
          class="k12ins__tile"
          role="button"
          tabindex="0"
          data-testid="insight-tile-practice"
          @click="emit('navigate', navigation('practiceSets'))"
          @keydown.enter="onNavKey($event, navigation('practiceSets'))"
        >
          <b
            ><span>{{ practicePending ?? '—' }}</span
            ><em v-if="practicePending != null">{{ t('k12.report.unitQuestions') }}</em></b
          >{{ t('k12.report.tiles.practicePending') }}
        </div>
      </div>
      <template v-if="weakBars.length">
        <div class="k12ins__section" style="margin-top: 16px">
          <h3 data-testid="insight-priority-title">{{ t('k12.report.priorityTitle') }}</h3>
          <span class="k12ins__hint" data-testid="insight-priority-note">{{
            t('k12.report.priorityNote')
          }}</span>
        </div>
        <div class="k12ins__priority" data-testid="insight-priority-card" style="margin-top: 8px">
          <div
            v-for="w in weakBars"
            :key="w.name"
            class="k12ins__bar"
            role="button"
            tabindex="0"
            data-testid="insight-weak-bar"
            @click="emit('navigate', navigation('mistakes', w.subject))"
            @keydown.enter="onNavKey($event, navigation('mistakes', w.subject))"
          >
            <span class="k12ins__barlabel">{{ w.name }}</span>
            <span class="k12ins__rail"
              ><span class="k12ins__fill" :style="{ width: w.pct + '%' }"
            /></span>
            <b>{{ w.count }}</b>
          </div>
        </div>
      </template>
      <div
        v-if="report.consecutive_fail_kps?.length"
        class="k12ins__notice k12ins__notice--accent k12ins__action"
        data-testid="insight-setback-action"
        style="margin-top: 14px"
      >
        <div>
          <b>{{
            t('k12.report.consecutiveFail', { topics: report.consecutive_fail_kps.join('、') })
          }}</b>
          <template v-if="report.suggestion"><br />{{ report.suggestion }}</template>
        </div>
        <button
          class="k12ins__button"
          data-testid="insight-fail-cta"
          @click="emit('navigate', navigation('week'))"
        >
          {{ t('k12.report.goWeek') }}
        </button>
      </div>
      <div
        v-if="practicePending != null && practicePending > 0"
        class="k12ins__notice k12ins__action"
        data-testid="insight-week-action"
        style="margin-top: 10px"
      >
        <div>
          <b>{{ t('k12.report.weekActionTitle') }}</b
          ><br />
          {{ t('k12.report.weekActionBody', { n: practicePending }) }}
        </div>
        <button
          class="k12ins__button"
          data-testid="insight-print-cta"
          @click="emit('navigate', navigation('practiceSets'))"
        >
          {{ t('k12.report.goPrint') }}
        </button>
      </div>
    </template>
    <div v-else class="k12ins__state" data-testid="insight-empty">
      {{ t('k12.report.empty') }}
    </div>
  </section>
</template>

<style scoped>
.k12ins {
  flex: 1;
  inline-size: 100%;
  max-inline-size: 1024px;
  min-height: 0;
  overflow: auto;
  padding: 16px 26px 48px;
}
.k12ins__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin: 18px 2px 10px;
}
.k12ins__h {
  font-size: 15px;
  color: var(--hc-text-primary);
  margin: 16px 0 8px;
}
.k12ins__hint {
  color: var(--hc-text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}
.k12ins__state {
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  padding: 11px 13px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--hc-text-secondary);
}
.k12ins__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 13px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  border: 0.5px solid var(--hc-border);
  color: var(--hc-error);
  font-size: 12.5px;
}
.k12ins__error button {
  flex-shrink: 0;
  border: 0.5px solid currentColor;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  padding: 6px 12px;
  cursor: pointer;
}
.k12ins__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}
.k12ins__tile {
  cursor: pointer;
  border: 0.5px solid transparent;
  border-radius: 14px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  padding: 14px 16px;
  font-size: 12px;
  color: var(--hc-text-secondary);
  transition:
    border-color 0.15s var(--hc-ease-out),
    box-shadow 0.2s var(--hc-ease-out),
    transform 0.15s var(--hc-ease-out);
}
.k12ins__tile:hover {
  border-color: var(--hc-border-hl);
  box-shadow: var(--hc-shadow-md);
  transform: translateY(-1px);
}
.k12ins__tile b {
  display: block;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--hc-text-primary);
  margin-bottom: 3px;
  font-variant-numeric: tabular-nums;
}
.k12ins__tile b em {
  margin-left: 3px;
  color: var(--hc-text-secondary);
  font-size: 12px;
  font-style: normal;
  font-weight: 600;
}
.k12ins__section {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 18px 2px 10px;
}
.k12ins__section h3 {
  margin: 0;
  color: var(--hc-text-primary);
  font-size: 13px;
}
.k12ins__priority {
  inline-size: 100%;
  max-inline-size: none;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 14px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
}
.k12ins__bar {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s var(--hc-ease-out);
}
.k12ins__bar:hover {
  background: var(--hc-bg-hover);
}
.k12ins__barlabel {
  width: 76px;
  flex-shrink: 0;
  color: var(--hc-text-secondary);
}
.k12ins__rail {
  flex: 1;
  height: 9px;
  border-radius: 99px;
  background: var(--hc-bg-input);
  overflow: hidden;
}
.k12ins__fill {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--hc-accent);
}
.k12ins__bar b {
  width: 26px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.k12ins__notice {
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  padding: 11px 13px;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  line-height: 1.55;
}
.k12ins__notice b {
  color: var(--hc-text-primary);
}
.k12ins__notice--accent {
  position: relative;
  padding-left: 17px;
}
.k12ins__notice--accent::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  bottom: 11px;
  width: 3px;
  border-radius: 2px;
  background: var(--hc-warning);
}
.k12ins__action {
  display: flex;
  align-items: center;
  gap: 14px;
}
.k12ins__action > div {
  flex: 1;
  min-width: 0;
}
.k12ins__button {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  padding: 6px 8px;
  border: 0.5px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--hc-text-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.15s var(--hc-ease-out),
    color 0.15s var(--hc-ease-out);
}
.k12ins__button:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
@media (max-width: 780px) {
  .k12ins {
    padding: 14px 16px 40px;
  }
}
</style>
