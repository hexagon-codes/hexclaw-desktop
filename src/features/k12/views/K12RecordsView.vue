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
import HcSelect from '@/components/common/HcSelect.vue'
import { useToast } from '@/composables/useToast'
import { useK12Store } from '../store'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'
import { k12ReviewRetry, k12ExportMd, k12AddAccumulation } from '@/api/k12'
import { MISTAKE_SCHEMA, ACCUMULATION_SCHEMA } from '../schemas'
import { printWorksheet, exportPdf, exportWord, worksheetFilename, download } from '../export'
import type { RecordItem } from '@/contracts'

const props = defineProps<{
  agentId: string
  agentName: string
  grade: string
}>()

const emit = defineEmits<{
  (e: 'go-tutor'): void
  (e: 'open-backup'): void
}>()

const { t } = useI18n()
const toast = useToast()
const store = useK12Store()

const sub = ref<'mistakes' | 'accumulation' | 'insight'>('mistakes')

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
    store.loadReport(props.agentId),
    store.loadStudyTime(props.agentId), // M1：投入感块（本月辅导次数）数据源
    reloadAccum(),
  ])
}
onMounted(reload)
// 切实例（多孩）→ 重置分科过滤 + 收起记录表单，避免带上一个孩子的筛选态
watch(() => props.agentId, () => { accumSubject.value = ''; accumAddOpen.value = false; reload() })

// 手动记积累本（#4）：家长在会话里遇到好东西 → 直接记进积累本（PRD §3.13）。
// entry_type 限积累型（好词好句/古诗/语法点/作文，镜像 store ACCUM_KEEP_TYPES）；纠错型走错题 tab。
// ── M1（对齐原型 app.html:1611-1618）：投入感块 + 学期汇总 ──
// 本月辅导次数 = study-time 当月各日 record_count 求和（每条记录≈一题一次，
// 与后端 studytime.go「基于记录活跃估算」同源口径；跨月天不计）。
const monthTutorCount = computed(() => {
  // 用本地时区拼当月 YYYY-MM：toISOString() 是 UTC 年月，UTC+8 每月头 8 小时会错到上月，
  // 与后端 studytime.go 的本地时区口径不一致。
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return (store.studyTime?.days ?? [])
    .filter((d) => d.date.startsWith(ym))
    .reduce((sum, d) => sum + d.record_count, 0)
})
// 学期分科计数：仅当 mistakes 下发 subject 时渲染（/mistakes subject 为已知 P2 后端缺口，不编造）
const SUBJECT_ORDER = ['数学', '语文', '英语', '物理', '化学']
const subjectCounts = computed(() => {
  const byName = new Map<string, number>()
  for (const it of store.mistakeView?.items ?? []) {
    const subj = typeof it.fields?.subject === 'string' ? it.fields.subject : ''
    if (subj) byName.set(subj, (byName.get(subj) ?? 0) + 1)
  }
  return SUBJECT_ORDER.filter((n) => byName.has(n)).map((n) => `${n} ${byName.get(n)}`)
})

const ACCUM_SUBJECTS = ['语文', '英语']
const ACCUM_TYPES = ['好词好句', '古诗', '语法点', '作文']
// HcSelect 选项（原生 select 在 WKWebView 显 macOS Aqua 样式 · BUG-20260708 D5/B2）
const accumSubjectOptions = computed(() => ACCUM_SUBJECTS.map((s) => ({ value: s, label: s })))
const accumTypeOptions = computed(() => ACCUM_TYPES.map((ty) => ({ value: ty, label: ty })))
const accumAddOpen = ref(false)
const accumForm = ref({ subject: '语文', entry_type: '好词好句', content: '' })
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

// 手工录入错题（20260709）：课堂/学校/线下没经过 App 的错题也能进本子（错题本价值=完整性）。
// 设计=跳过拍照·直接给文本进**同一条验算管道**（复用 store.grade：题目 + 孩子答案 → 验算 → 入库），
// 而非自由便签；来源在后端补 source 字段后标「🖊 家长记入」区别拍照/已验算（当前后端无 source 字段，先入库）。
const mistakeAddOpen = ref(false)
const mistakeForm = ref({ subject: '', problem: '', studentAnswer: '', knowledgePoints: '' })
const mistakeSubjectOptions = computed(() => K12_GRADE_SUBJECT_OPTIONS.map(({ value, labelKey }) => ({
  value,
  label: t(labelKey),
})))
const mistakeSaving = ref(false)
async function submitMistake() {
  const problem = mistakeForm.value.problem.trim()
  if (!mistakeForm.value.subject || !problem || mistakeSaving.value) return
  mistakeSaving.value = true
  try {
    const kps = mistakeForm.value.knowledgePoints
      .split(/[·,，、/]/).map((s) => s.trim()).filter(Boolean)
    const res = await store.grade({
      agent: props.agentId,
      subject: mistakeForm.value.subject,
      grade: props.grade,
      problem,
      student_answer: mistakeForm.value.studentAnswer.trim() || undefined,
      knowledge_points: kps.length ? kps : undefined,
    })
    toast.success(res.recordCreated ? t('k12.mistakeAdd.recorded') : t('k12.mistakeAdd.notWrong'))
    mistakeForm.value = { subject: '', problem: '', studentAnswer: '', knowledgePoints: '' }
    mistakeAddOpen.value = false
    await store.loadMistakes(props.agentId)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    mistakeSaving.value = false
  }
}

// 自定义组卷（20260709）：「一键出复习卷」保持零配置智能默认（review 区主动作）；想微调的少数家长
// 走此次级面板（每题几道 / 难度 / 总量），渐进披露不把主动作藏在参数后。生成走客户端 printWorksheet。
const customPaperOpen = ref(false)
const paperForm = ref({ perQ: '1', difficulty: 'same', total: 'all' })
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
function genCustomPaper() {
  customPaperOpen.value = false
  // 客户端出卷=printWorksheet(当前错题)。`total` 客户端可兑现(切片限量);`perQ`(每题变式数)/
  // `difficulty`(难度)需后端组卷端点按参数出变式题,当前客户端出卷无法变更,待后端 /paper 端点补齐(契约缺口)。
  const limit = paperForm.value.total === 'all' ? currentItems().length : Number(paperForm.value.total)
  printWorksheet(currentItems().slice(0, limit), worksheetMeta())
  toast.success(t('k12.customPaper.generated'))
}

const view = computed(() => store.mistakeView)
const accumView = computed(() => store.accumView)
const report = computed(() => store.report)

// 原型 c8a194e：「本周该练」标题带跨科分布（数学 2 · 语文 1 · 英语 1）。
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

// 复习完成率：-1 哨兵（分母为 0）→ 显示「—」
const reviewRateDisplay = computed(() => {
  const r = report.value?.review_completion_rate
  return r == null || r < 0 ? '—' : `${Math.round(r * 100)}%`
})
// 薄弱知识点 TOP3（真实端点）归一化为百分比宽度
const weakBars = computed(() => {
  const list = report.value?.weak_top3 ?? []
  const max = Math.max(1, ...list.map((w) => w.count))
  return list.map((w) => ({ name: w.knowledge_point, count: w.count, pct: Math.round((w.count / max) * 100) }))
})
// 20260709：学习时长模块删除（口径不可信·线下辅导统计不到；不可操作；诱导时长考核，与「掌握>投入」相悖）。
// 投入感由学情「本月辅导 N 次」承接。studyBars/学习时长视图已移除。

async function onAction(payload: { id: 'practiceAgain' | 'markMastered' | 'detail'; record: RecordItem }) {
  const { id, record } = payload
  if (id === 'markMastered') {
    try {
      await store.markMastered(props.agentId, record.recordId, record.version)
      // 「他会了」是家长的情绪峰值时刻——toast 说清结果；真「撤销」待后端状态回退端点（原型 20260709 记档 P2）。
      toast.success(t('k12.records.masteredToast'))
    } catch (e) {
      // 409 版本冲突：并发改动，刷新后重试
      toast.error(e instanceof Error ? e.message : String(e))
      await reload()
    }
  } else if (id === 'practiceAgain') {
    // 「再练一道」：调 POST /review/retry 出同知识点相似题（过 solve 验算链）。
    // 原型终态=变式直接入本周复习卷不亮答案；当前后端 retry 无持久化且 solution 题答混排（P2 缺口），
    // 过渡为「真遮罩弹层」：答案默认模糊不可选中，家长明确点「显示答案」才揭示——守答案承诺交互兑现。
    retry.value = { open: true, loading: true, solution: '', badge: '', revealed: false }
    try {
      const res = await k12ReviewRetry({ agent: props.agentId, record_id: record.recordId, grade: props.grade })
      retry.value = { open: true, loading: false, solution: res.solution, badge: res.badge, revealed: false }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      retry.value = { open: false, loading: false, solution: '', badge: '', revealed: false }
    }
  } else {
    toast.info(t('records.detail'))
  }
}

// 「再练一道」变式题结果弹层（守答案真遮罩：revealed=false 时答案模糊+禁选中，点按才揭示）。
const retry = ref<{ open: boolean; loading: boolean; solution: string; badge: string; revealed: boolean }>({
  open: false,
  loading: false,
  solution: '',
  badge: '',
  revealed: false,
})
function closeRetry() {
  retry.value = { open: false, loading: false, solution: '', badge: '', revealed: false }
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
function doPrint() {
  printWorksheet(currentItems(), worksheetMeta())
}
function doExport(ext: 'pdf' | 'doc') {
  exportOpen.value = false
  const d = todayLabel().replace(/-/g, '').slice(4)
  if (ext === 'pdf') exportPdf(currentItems(), worksheetMeta())
  else exportWord(currentItems(), worksheetMeta(), worksheetFilename(props.agentName, t('k12.records.worksheetTitle'), d, d, 'doc'))
}
// 导出完整错题本为 Markdown（后端 GET /export 直出 md，含全部记录/状态；补齐审计 #6 未闭环）。
async function doExportMd() {
  exportOpen.value = false
  try {
    const res = await k12ExportMd(props.agentId)
    const d = todayLabel().replace(/-/g, '').slice(4)
    download(worksheetFilename(props.agentName, t('k12.collections.mistakes'), d, d, 'md'), res.content, 'text/markdown;charset=utf-8')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="k12rec">
    <!-- 实例上下文头卡（🎓 姓名 + 年级 + 回辅导/备课卡）由外层 k12enh-tabs 唯一提供；
         此处不再自绘，避免错题本 tab 下姓名/年级重复渲染两遍（BUG-20260708 B8）。 -->

    <!-- 二级 tab：错题 / 积累 / 学情 -->
    <div class="k12rec__tabs">
      <div class="seg">
        <button :class="{ on: sub === 'mistakes' }" @click="sub = 'mistakes'">{{ t('k12.subTabs.mistakes') }}</button>
        <button :class="{ on: sub === 'accumulation' }" @click="sub = 'accumulation'">{{ t('k12.subTabs.accumulation') }}</button>
        <button :class="{ on: sub === 'insight' }" @click="sub = 'insight'">{{ t('k12.subTabs.insight') }}</button>
      </div>
      <span class="k12rec__sp" />
      <!-- 20260709 视觉评审（原型 c8a194e 定稿）：①功能位 emoji → 单色描边图标；②备份/恢复低频动作
           不占常驻顶栏 → 与导出合并进「⋯」溢出菜单（导出项仅错题 tab，备份全 tab 可达）。 -->
      <button v-if="sub === 'mistakes'" class="btn k12rec__addbtn" data-testid="mistake-add-open" @click="mistakeAddOpen = !mistakeAddOpen">
        <svg class="k12ic" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
        {{ t('k12.mistakeAdd.open') }}
      </button>
      <div class="k12rec__export">
        <button class="btn" :title="t('k12.actions.more')" @click="exportOpen = !exportOpen">⋯</button>
        <div v-if="exportOpen" class="k12rec__menu">
          <template v-if="sub === 'mistakes'">
            <button @click="doExport('pdf')">{{ t('k12.actions.export') }} PDF</button>
            <button @click="doExport('doc')">{{ t('k12.actions.export') }} Word</button>
            <button @click="doExportMd">{{ t('k12.actions.export') }} Markdown</button>
          </template>
          <button @click="exportOpen = false; emit('open-backup')">{{ t('k12.actions.backup') }}</button>
        </div>
      </div>
    </div>

    <div class="k12rec__body">
      <!-- 错题本：复习引擎（进步趋势 + 复习队列 + 每条再练/他会了）-->
      <section v-if="sub === 'mistakes'">
        <div v-if="store.error" class="k12rec__err">{{ store.error }}</div>

        <RecordList v-if="view" :schema="MISTAKE_SCHEMA" :view="view" @action="onAction">
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
          <!-- 原型 c8a194e：周五留存钩子独立成行（后端 cronspec 0 19 * * 5，建档 setupAutomation 已接线） -->
          <template #review-foot>{{ t('k12.records.weeklyHook') }}</template>
          <!-- 原型 c8a194e：档案区标题「全部错题 (N)」——summary 定稿文案，不带功能说明书 -->
          <template #list-title="{ count }">{{ t('k12.records.allMistakes') }} ({{ count }})</template>
          <template #review-actions>
            <button class="btn btn-primary" @click="doPrint">
              <svg class="k12ic" viewBox="0 0 24 24"><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v8H6z" /></svg>
              {{ t('k12.records.genWorksheet') }}
            </button>
            <button class="btn" data-testid="custom-paper-open" @click="customPaperOpen = !customPaperOpen">
              <svg class="k12ic" viewBox="0 0 24 24"><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M2 14h4" /><path d="M10 8h4" /><path d="M18 16h4" /></svg>
              {{ t('k12.records.customPaper') }}
            </button>
          </template>
        </RecordList>

        <p class="k12rec__hint">{{ t('k12.records.stateMachineHint') }}</p>
      </section>

      <!-- 积累本：语/英沉淀（真实 /accumulation）——记录本原语第二场景 -->
      <section v-else-if="sub === 'accumulation'">
        <!-- 分科过滤 chips（#5）+ 手动记录入口（#4）-->
        <div class="k12accum__bar">
          <div class="k12accum__filters">
            <button
              class="chip" :class="{ on: accumSubject === '' }"
              data-testid="accum-filter-all" @click="setAccumSubject('')"
            >{{ t('k12.accum.filterAll') }}</button>
            <button
              class="chip" :class="{ on: accumSubject === '语文' }"
              data-testid="accum-filter-chinese" @click="setAccumSubject('语文')"
            >{{ t('k12.accum.filterChinese') }}</button>
            <button
              class="chip" :class="{ on: accumSubject === '英语' }"
              data-testid="accum-filter-english" @click="setAccumSubject('英语')"
            >{{ t('k12.accum.filterEnglish') }}</button>
          </div>
          <span class="k12rec__sp" />
          <button class="btn" data-testid="accum-add-open" @click="accumAddOpen = !accumAddOpen">
            {{ t('k12.accum.addOpen') }}
          </button>
        </div>

        <!-- 手动记录表单（#4）-->
        <div v-if="accumAddOpen" class="k12accum__form">
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
          <textarea
            v-model="accumForm.content"
            class="k12accum__content"
            data-testid="accum-add-content"
            :placeholder="t('k12.accum.contentPlaceholder')"
            rows="2"
          />
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

        <RecordList v-if="accumView && accumView.items.length" :schema="ACCUMULATION_SCHEMA" :view="accumView" />
        <p v-else class="k12rec__hint">{{ t('k12.accumulationEmpty') }}</p>
        <!-- 分界规则脚注（原型 rc1 · 2026-07-08 口径）：错了要改→错题 / 好东西要记住→积累 -->
        <p class="k12rec__hint">{{ t('k12.records.dividerRule') }}</p>
      </section>

      <!-- 学情：真实 /insight-report（趋势/薄弱/连续挫败/建议）+ /study-time（一维按日）-->
      <section v-else class="k12rec__insight">
        <!-- 标题 + 月度生成 note（原型 rc2 cxsec；月报由 cron monthly-report 推送，见 cronspec）-->
        <div class="k12rec__reporthead">
          <h3 class="k12rec__h" style="margin: 0">{{ t('k12.report.title') }}</h3>
          <span class="k12rec__hint" style="margin: 0">{{ t('k12.report.monthlyNote') }}</span>
        </div>
        <template v-if="report && report.trend.total">
          <div class="k12rec__tiles">
            <div class="k12tile"><b>{{ monthTutorCount }} 次</b>{{ t('k12.report.tiles.tutorCount') }}</div>
            <div class="k12tile"><b>{{ report.month_new_mistakes }}</b>{{ t('k12.report.tiles.newMistakes') }}</div>
            <div class="k12tile"><b>{{ reviewRateDisplay }}</b>{{ t('k12.report.tiles.reviewRate') }}</div>
            <div class="k12tile"><b>{{ report.trend.mastered }} · {{ report.trend.reviewing }}</b>{{ t('k12.report.tiles.masteredTodo') }}</div>
          </div>
          <!-- 学期汇总（原型 1618）：分科段仅当 subject 数据可得时渲染 -->
          <p class="k12rec__hint" data-testid="k12-semester-note" style="margin-top: 8px">
            {{ t('k12.report.semesterTotal', { n: report.trend.total }) }}<template v-if="subjectCounts.length">（{{ subjectCounts.join(' · ') }}）</template> · {{ t('k12.report.semesterStatus', { m: report.trend.mastered, r: report.trend.reviewing, d: report.trend.retried }) }}
          </p>
          <h3 class="k12rec__h">{{ t('k12.report.weakTop3') }}</h3>
          <div class="k12bars">
            <div v-for="w in weakBars" :key="w.name" class="k12bar">
              <span class="k12bar__label">{{ w.name }}</span>
              <span class="k12bar__rail"><span class="k12bar__fill" :style="{ width: w.pct + '%' }" /></span>
              <b>{{ w.count }}</b>
            </div>
          </div>
          <div v-if="report.consecutive_fail_kps && report.consecutive_fail_kps.length" class="k12rec__alert">
            <b>⚠ {{ t('k12.report.consecutiveFail') }}</b> · {{ report.consecutive_fail_kps.join('、') }}
          </div>
          <div v-if="report.suggestion" class="k12rec__sugg">💡 {{ report.suggestion }}</div>
        </template>
        <p v-else class="k12rec__hint">{{ report?.suggestion || t('k12.report.empty') }}</p>
      </section>
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
        <div class="k12accum__form k12accum__form--modal" data-testid="mistake-add-form">
          <div class="k12rec__addhint">{{ t('k12.mistakeAdd.hint') }}</div>
          <div class="k12accum__field" data-testid="mistake-subject">
            <span>{{ t('k12.accum.subject') }}</span>
            <HcSelect
              v-model="mistakeForm.subject"
              :options="mistakeSubjectOptions"
              :placeholder="t('k12.prep.pickHint')"
            />
          </div>
          <input
            v-model="mistakeForm.problem"
            class="k12accum__content"
            data-testid="mistake-problem"
            :placeholder="t('k12.mistakeAdd.problemPh')"
          />
          <input
            v-model="mistakeForm.studentAnswer"
            class="k12accum__content"
            :placeholder="t('k12.mistakeAdd.answerPh')"
          />
          <input
            v-model="mistakeForm.knowledgePoints"
            class="k12accum__content"
            :placeholder="t('k12.mistakeAdd.kpPh')"
          />
          <div class="k12accum__actions">
            <button class="btn btn-ghost" @click="mistakeAddOpen = false">{{ t('k12.accum.cancel') }}</button>
            <button
              class="btn btn-primary"
              data-testid="mistake-submit"
              :disabled="!mistakeForm.subject || !mistakeForm.problem.trim() || mistakeSaving"
              @click="submitMistake"
            >{{ t('k12.mistakeAdd.submit') }}</button>
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
          <b>{{ t('k12.records.retryTitle') }}</b>
          <span v-if="retry.badge" class="pill pill-green">{{ retry.badge }}</span>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="closeRetry">✕</button>
        </div>
        <p v-if="retry.loading" class="k12rec__hint">{{ t('k12.records.retryLoading') }}</p>
        <template v-else>
          <p class="k12retry__mask">🔒 {{ t('k12.records.retryMaskHint') }}</p>
          <!-- 守答案真遮罩：未揭示时模糊 + 禁选中（防孩子凑近一眼看光），家长点按才显示 -->
          <div class="k12retry__bodywrap" :class="{ 'k12retry__bodywrap--masked': !retry.revealed }">
            <pre class="k12retry__body" :aria-hidden="!retry.revealed">{{ retry.solution }}</pre>
            <button
              v-if="!retry.revealed"
              class="btn btn-primary k12retry__reveal"
              data-testid="retry-reveal"
              @click="retry.revealed = true"
            >{{ t('k12.records.retryReveal') }}</button>
          </div>
        </template>
      </div>
    </div>
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
.k12accum__bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.k12accum__filters { display: inline-flex; gap: 6px; }
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
.k12accum__actions { display: flex; justify-content: flex-end; gap: 8px; }
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
/* 「本周该练」行动卡：跨科分布 + 趋势 pill（原型 stpill got/done 同源色） */
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
.k12retry__body { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.6; color: var(--hc-text-primary); margin: 0; }
/* 守答案真遮罩：模糊 + 禁选中；揭示按钮悬浮居中 */
.k12retry__bodywrap { position: relative; }
.k12retry__bodywrap--masked .k12retry__body { filter: blur(7px); user-select: none; pointer-events: none; }
.k12retry__reveal { position: absolute; inset: 0; margin: auto; width: fit-content; height: fit-content; }
</style>
