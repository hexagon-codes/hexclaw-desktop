<!--
  K12 学情面板（PRD §3.11）· IA 定稿后为顶栏一等 Tab（辅导｜学习档案｜学情）。
  真实 /insight-report（趋势/薄弱 TOP3/连续挫败/建议）；不展示辅导次数/学习时长
  （架构设计 v0.5.0《明确不做》#6，§5.7 派生指标口径表内无「辅导次数」）。
  从 K12RecordsView 学情二级 Tab 抽出（2026-07-18 IA 迁移）；数据仍走 useK12Store 单一事实源。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { k12ListPracticeSets } from '@/api/k12'
import { useK12Store } from '../store'

const props = defineProps<{
  agentId: string
  /** 年级（k12.grade_term，K12ChatEnhancement 透传）：标题「{grade}学习概览」；缺省用通用文案 */
  grade?: string
}>()
const emit = defineEmits<{
  /** 学情=路由器（§3.11）：瓷片/薄弱条/挫败 CTA 点击 → 外层切学习档案。
   *  TODO(子 Tab 直达)：RecordsView 归另一 agent，本轮外层只切到 records 首页，target 供后续接线。 */
  (e: 'navigate', target: 'week' | 'mistakes' | 'practiceSets'): void
}>()
const { t } = useI18n()
const store = useK12Store()

// 练习集待打印数（原型 2617 第四瓷片）：draft 篮 items 求和，自拉不进 store（练习集面板归另一 agent）。
const practicePending = ref<number | null>(null)
async function loadPracticePending() {
  try {
    const resp = await k12ListPracticeSets(props.agentId, 'draft')
    practicePending.value = (resp.items ?? []).reduce((sum, s) => sum + (s.items?.length ?? 0), 0)
  } catch {
    practicePending.value = null // 拉取失败显示「—」，不编数
  }
}

async function reload() {
  if (!props.agentId) return
  await Promise.all([
    store.loadReport(props.agentId),
    store.loadMistakes(props.agentId), // 学期分科计数依赖错题 subject
    loadPracticePending(),
  ])
}
onMounted(reload)
watch(() => props.agentId, reload)

const report = computed(() => store.report)

// 学期分科计数：仅当 mistakes 下发 subject 时渲染（不编造）。
const SUBJECT_ORDER = ['数学', '语文', '英语', '科学', '信息科技']
const subjectCounts = computed(() => {
  const byName = new Map<string, number>()
  for (const it of store.mistakeView?.items ?? []) {
    const subj = typeof it.fields?.subject === 'string' ? it.fields.subject : ''
    if (subj) byName.set(subj, (byName.get(subj) ?? 0) + 1)
  }
  return SUBJECT_ORDER.filter((n) => byName.has(n)).map((n) => `${n} ${byName.get(n)}`)
})

// 复习完成率：-1 哨兵（分母为 0）→ 显示「—」
const reviewRateDisplay = computed(() => {
  const r = report.value?.review_completion_rate
  return r == null || r < 0 ? '—' : `${Math.round(r * 100)}%`
})

// 薄弱知识点 TOP3 归一化为百分比宽度
const weakBars = computed(() => {
  const list = report.value?.weak_top3 ?? []
  const max = Math.max(1, ...list.map((w) => w.count))
  return list.map((w) => ({ name: w.knowledge_point, count: w.count, pct: Math.round((w.count / max) * 100) }))
})
</script>

<template>
  <section class="k12ins" data-testid="insight-panel">
    <div class="k12ins__head">
      <!-- 原型 2613：「学情报告·每月1日自动生成」→「{grade}学习概览 · 从真实批改与复练证据生成」 -->
      <h3 class="k12ins__h" style="margin: 0" data-testid="insight-title">
        {{ grade ? t('k12.report.titleWithGrade', { grade }) : t('k12.report.title') }}
      </h3>
      <span class="k12ins__hint" style="margin: 0">{{ t('k12.report.monthlyNote') }}</span>
    </div>
    <template v-if="report && report.trend.total">
      <!-- 瓷片=路由器（§3.11）：除首块「证据已掌握」（§5.7 合法口径，替代已退役的辅导次数）外均可点跳学习档案 -->
      <div class="k12ins__tiles">
        <div class="k12ins__tile" data-testid="insight-tile-mastered"><b>{{ report.trend.mastered }} 条</b>{{ t('k12.report.tiles.mastered') }}</div>
        <div
          class="k12ins__tile k12ins__tile--nav" role="button" tabindex="0" data-testid="insight-tile-mistakes"
          @click="emit('navigate', 'mistakes')" @keydown.enter="emit('navigate', 'mistakes')"
        ><b>{{ report.month_new_mistakes }}</b>{{ t('k12.report.tiles.newMistakes') }}</div>
        <div
          class="k12ins__tile k12ins__tile--nav" role="button" tabindex="0" data-testid="insight-tile-week"
          @click="emit('navigate', 'week')" @keydown.enter="emit('navigate', 'week')"
        ><b>{{ reviewRateDisplay }}</b>{{ t('k12.report.tiles.reviewRate') }}</div>
        <!-- 原型 2617 第四瓷片：练习集「待打印 N 道」（§4.11 术语裁决表述；已掌握·待复习并进下方学期汇总行） -->
        <div
          class="k12ins__tile k12ins__tile--nav" role="button" tabindex="0" data-testid="insight-tile-practice"
          @click="emit('navigate', 'practiceSets')" @keydown.enter="emit('navigate', 'practiceSets')"
        ><b>{{ practicePending != null ? `${practicePending} 道` : '—' }}</b>{{ t('k12.report.tiles.practicePending') }}</div>
      </div>
      <p class="k12ins__hint" data-testid="k12-semester-note" style="margin-top: 8px">
        {{ t('k12.report.semesterTotal', { n: report.trend.total }) }}<template v-if="subjectCounts.length">（{{ subjectCounts.join(' · ') }}）</template> · {{ t('k12.report.semesterStatus', { m: report.trend.mastered, r: report.trend.reviewing, d: report.trend.retried }) }}
      </p>
      <h3 class="k12ins__h">{{ t('k12.report.weakTop3') }}</h3>
      <!-- 薄弱条可点 → 全部错题（路由器出口；子 Tab 直达见 navigate TODO） -->
      <div class="k12ins__bars">
        <div
          v-for="w in weakBars" :key="w.name" class="k12ins__bar k12ins__bar--nav"
          role="button" tabindex="0" data-testid="insight-weak-bar"
          @click="emit('navigate', 'mistakes')" @keydown.enter="emit('navigate', 'mistakes')"
        >
          <span class="k12ins__barlabel">{{ w.name }}</span>
          <span class="k12ins__rail"><span class="k12ins__fill" :style="{ width: w.pct + '%' }" /></span>
          <b>{{ w.count }}</b>
        </div>
      </div>
      <div v-if="report.consecutive_fail_kps && report.consecutive_fail_kps.length" class="k12ins__alert">
        <b>⚠ {{ t('k12.report.consecutiveFail') }}</b> · {{ report.consecutive_fail_kps.join('、') }}
        <button class="k12ins__cta" data-testid="insight-fail-cta" @click="emit('navigate', 'week')">
          {{ t('k12.report.goWeek') }}
        </button>
      </div>
      <div v-if="report.suggestion" class="k12ins__sugg">💡 {{ report.suggestion }}</div>
    </template>
    <p v-else class="k12ins__hint">{{ report?.suggestion || t('k12.report.empty') }}</p>
  </section>
</template>

<style scoped>
.k12ins { padding: 14px 18px 40px; max-width: 720px; }
.k12ins__head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.k12ins__h { font-size: 14px; color: var(--hc-text-primary); margin: 16px 0 8px; }
.k12ins__hint { color: var(--hc-text-muted); font-size: 11.5px; line-height: 1.6; }
.k12ins__tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.k12ins__tile {
  border: .5px solid var(--hc-border); border-radius: var(--hc-radius-lg); background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm); padding: 13px 15px; font-size: 11.5px; color: var(--hc-text-secondary);
}
.k12ins__tile b {
  display: block; font-size: 21px; font-weight: 700; letter-spacing: -.02em;
  color: var(--hc-text-primary); margin-bottom: 3px; font-variant-numeric: tabular-nums;
}
.k12ins__tile--nav { cursor: pointer; transition: border-color .15s, box-shadow .15s, background .15s; }
.k12ins__tile--nav:hover { border-color: var(--hc-accent); background: var(--hc-bg-hover); box-shadow: var(--hc-shadow-md, var(--hc-shadow-sm)); }
.k12ins__bar--nav { cursor: pointer; border-radius: var(--hc-radius-md); padding: 2px 4px; margin: -2px -4px; transition: background .15s; }
.k12ins__bar--nav:hover { background: var(--hc-bg-hover); }
.k12ins__cta {
  display: block; margin-top: 7px; font: inherit; font-size: 11.5px; font-weight: 550;
  border: .5px solid var(--hc-border); border-radius: var(--hc-radius-md); background: transparent;
  color: var(--hc-accent); padding: 4px 10px; cursor: pointer;
}
.k12ins__cta:hover { background: var(--hc-bg-hover); }
.k12ins__bars { display: grid; gap: 7px; max-width: 560px; }
.k12ins__bar { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.k12ins__barlabel { width: 84px; flex-shrink: 0; color: var(--hc-text-secondary); }
.k12ins__rail { flex: 1; height: 8px; border-radius: 999px; background: var(--hc-bg-input); overflow: hidden; }
.k12ins__fill { display: block; height: 100%; border-radius: 999px; background: var(--hc-accent); }
.k12ins__alert {
  margin-top: 12px; padding: 10px 13px; border: .5px solid var(--hc-border); border-left: none;
  border-radius: var(--hc-radius-md); background: var(--hc-bg-card); font-size: 12px; color: var(--hc-text-secondary);
  position: relative; padding-left: 17px;
}
.k12ins__alert::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--hc-warning, #e69500); }
.k12ins__alert b { color: var(--hc-text-primary); }
.k12ins__sugg {
  margin-top: 10px; padding: 10px 13px; border: .5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card); font-size: 12px; color: var(--hc-text-secondary); line-height: 1.6;
}
</style>
