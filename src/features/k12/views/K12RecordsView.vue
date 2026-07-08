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
    reloadAccum(),
  ])
}
onMounted(reload)
// 切实例（多孩）→ 重置分科过滤 + 收起记录表单，避免带上一个孩子的筛选态
watch(() => props.agentId, () => { accumSubject.value = ''; accumAddOpen.value = false; reload() })

// 手动记积累本（#4）：家长在会话里遇到好东西 → 直接记进积累本（PRD §3.13）。
// entry_type 限积累型（好词好句/古诗/语法点/作文，镜像 store ACCUM_KEEP_TYPES）；纠错型走错题 tab。
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
const mistakeForm = ref({ problem: '', studentAnswer: '', knowledgePoints: '' })
const mistakeSaving = ref(false)
async function submitMistake() {
  const problem = mistakeForm.value.problem.trim()
  if (!problem || mistakeSaving.value) return
  mistakeSaving.value = true
  try {
    const kps = mistakeForm.value.knowledgePoints
      .split(/[·,，、/]/).map((s) => s.trim()).filter(Boolean)
    const res = await store.grade({
      agent: props.agentId,
      grade: props.grade,
      problem,
      student_answer: mistakeForm.value.studentAnswer.trim() || undefined,
      knowledge_points: kps.length ? kps : undefined,
    })
    toast.success(res.recordCreated ? t('k12.mistakeAdd.recorded') : t('k12.mistakeAdd.notWrong'))
    mistakeForm.value = { problem: '', studentAnswer: '', knowledgePoints: '' }
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
      toast.success(t('records.markMastered'))
    } catch (e) {
      // 409 版本冲突：并发改动，刷新后重试
      toast.error(e instanceof Error ? e.message : String(e))
      await reload()
    }
  } else if (id === 'practiceAgain') {
    // 「再练一道」：调 POST /review/retry 出同知识点相似题（过 solve 验算链），
    // 结果给家长核对（守答案遮罩：先别给孩子看）。
    retry.value = { open: true, loading: true, solution: '', badge: '' }
    try {
      const res = await k12ReviewRetry({ agent: props.agentId, record_id: record.recordId, grade: props.grade })
      retry.value = { open: true, loading: false, solution: res.solution, badge: res.badge }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      retry.value = { open: false, loading: false, solution: '', badge: '' }
    }
  } else {
    toast.info(t('records.detail'))
  }
}

// 「再练一道」变式题结果弹层（守答案遮罩：答案供家长核对，先别给孩子看）。
const retry = ref<{ open: boolean; loading: boolean; solution: string; badge: string }>({
  open: false,
  loading: false,
  solution: '',
  badge: '',
})
function closeRetry() {
  retry.value = { open: false, loading: false, solution: '', badge: '' }
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
      <template v-if="sub === 'mistakes'">
        <button class="btn" data-testid="mistake-add-open" @click="mistakeAddOpen = !mistakeAddOpen">✏️ {{ t('k12.mistakeAdd.open') }}</button>
        <div class="k12rec__export">
          <button class="btn" @click="exportOpen = !exportOpen">{{ t('k12.actions.export') }} ▾</button>
          <div v-if="exportOpen" class="k12rec__menu">
            <button @click="doExport('pdf')">PDF</button>
            <button @click="doExport('doc')">Word</button>
            <button @click="doExportMd">Markdown</button>
          </div>
        </div>
      </template>
      <button class="btn" @click="emit('open-backup')">{{ t('k12.actions.backup') }}</button>
    </div>

    <div class="k12rec__body">
      <!-- 错题本：复习引擎（进步趋势 + 复习队列 + 每条再练/他会了）-->
      <section v-if="sub === 'mistakes'">
        <div v-if="store.error" class="k12rec__err">{{ store.error }}</div>

        <!-- 手工录入错题（20260709）：课堂/学校/线下没经过 App 的错题也能进本子。走 store.grade 同一验算管道。 -->
        <div v-if="mistakeAddOpen" class="k12accum__form" data-testid="mistake-add-form">
          <div class="k12rec__addhint">{{ t('k12.mistakeAdd.hint') }}</div>
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
              :disabled="!mistakeForm.problem.trim() || mistakeSaving"
              @click="submitMistake"
            >{{ t('k12.mistakeAdd.submit') }}</button>
          </div>
        </div>

        <RecordList v-if="view" :schema="MISTAKE_SCHEMA" :view="view" @action="onAction">
          <template #review-actions>
            <button class="btn btn-primary" @click="doPrint">
              🖨 {{ t('k12.records.genWorksheet') }}
            </button>
            <button class="btn" data-testid="custom-paper-open" @click="customPaperOpen = !customPaperOpen">
              ⚙ {{ t('k12.records.customPaper') }}
            </button>
          </template>
        </RecordList>

        <!-- 自定义组卷次级面板（渐进披露；一键零配置仍是主动作） -->
        <div v-if="customPaperOpen" class="k12accum__form" data-testid="custom-paper-form">
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
      </section>

      <!-- 学情：真实 /insight-report（趋势/薄弱/连续挫败/建议）+ /study-time（一维按日）-->
      <section v-else class="k12rec__insight">
        <template v-if="report && report.trend.total">
          <div class="k12rec__tiles">
            <div class="k12tile"><b>{{ report.month_new_mistakes }}</b>{{ t('k12.report.tiles.newMistakes') }}</div>
            <div class="k12tile"><b>{{ reviewRateDisplay }}</b>{{ t('k12.report.tiles.reviewRate') }}</div>
            <div class="k12tile"><b>{{ report.trend.mastered }} · {{ report.trend.reviewing }}</b>{{ t('k12.report.tiles.masteredTodo') }}</div>
          </div>
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

    <!-- 「再练一道」变式题结果弹层 -->
    <div v-if="retry.open" class="k12retry" @click.self="closeRetry">
      <div class="k12retry__card">
        <div class="k12retry__head">
          <b>✏️ {{ t('k12.records.retryTitle') }}</b>
          <span v-if="retry.badge" class="pill pill-green">{{ retry.badge }}</span>
          <span class="k12rec__sp" />
          <button class="btn btn-ghost" @click="closeRetry">✕</button>
        </div>
        <p v-if="retry.loading" class="k12rec__hint">{{ t('k12.records.retryLoading') }}</p>
        <template v-else>
          <p class="k12retry__mask">🔒 {{ t('k12.records.retryMaskHint') }}</p>
          <pre class="k12retry__body">{{ retry.solution }}</pre>
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
.k12rec__tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
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
/* 再练一道弹层 */
.k12retry { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.32); padding: 24px; }
.k12retry__card { width: min(560px, 100%); max-height: 80vh; overflow: auto; background: var(--hc-bg-elevated); border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-lg); box-shadow: var(--hc-shadow-lg); padding: 16px 18px; }
.k12retry__head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.k12retry__mask { font-size: 11.5px; color: var(--hc-warning); margin-bottom: 8px; }
.k12retry__body { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.6; color: var(--hc-text-primary); margin: 0; }
</style>
