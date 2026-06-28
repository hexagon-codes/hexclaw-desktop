<script setup lang="ts">
/**
 * 品牌一致的「日期区间」选择器（取代原生 <input type="date">）。
 *
 * 为什么自渲染：原生 <input type="date"> 的日历弹层由 OS 渲染——在 macOS WKWebView 下
 * 是英文 Su/Mo + 系统外观，无法 CSS 定制、与应用中文柔和设计语言完全脱节（同 HcSelect 的
 * 原生 <select> 困境）。本组件 Teleport 到 body 自绘单面板月历，全平台一致、可样式化、本地化。
 *
 * 设计：accent 实心端点 + 浅色区间带（连续、端点圆角）+ 今天细环 + 跨月弱化；
 *       月/星期标签走 Intl.DateTimeFormat（跟随 i18n locale，零硬编码三语）；
 *       周首日按区域（zh/ug=周一，其它=周日）；点击外部/Esc/滚动翻转复用 HcSelect 模式。
 * v-model：from / to（ISO 'YYYY-MM-DD'），与父级两个独立 ref 契约对齐。
 */
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    from?: string
    to?: string
    disabled?: boolean
    fromLabel?: string
    toLabel?: string
    fromTestid?: string
    toTestid?: string
  }>(),
  { from: '', to: '', disabled: false, fromLabel: '', toLabel: '', fromTestid: '', toTestid: '' },
)

const emit = defineEmits<{
  'update:from': [v: string]
  'update:to': [v: string]
}>()

const { t, locale } = useI18n()

// ── 日期工具（一律用本地 Y/M/D，绝不经 UTC，避免时区把日期推前后一天）──
function parseISO(s?: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}
function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function sameDay(a: Date | null, b: Date | null): boolean {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const today = new Date()
const fromD = computed(() => parseISO(props.from))
const toD = computed(() => parseISO(props.to))

// 周首日：中文/维语习惯周一，其它周日。
const weekStart = computed(() => (/^(zh|ug)/i.test(locale.value) ? 1 : 0))
const intlLocale = computed(() => locale.value || 'en')

const weekdayLabels = computed(() => {
  // narrow：中文出「日一二三四五六」、英文出「S M T W T F S」，比 short 更适合 7 列窄格。
  const fmt = new Intl.DateTimeFormat(intlLocale.value, { weekday: 'narrow' })
  // 2023-01-01 是周日，作锚生成「从 weekStart 起」的 7 个短标签。
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + ((weekStart.value + i) % 7))))
})

// ── 弹层 + 视图月 ──
const open = ref(false)
const triggerRef = ref<HTMLDivElement | null>(null)
const popRef = ref<HTMLDivElement | null>(null)
const popStyle = ref<Record<string, string>>({})
const viewMonth = ref(startOfMonth(fromD.value || toD.value || today))
const hoverD = ref<Date | null>(null)

const headerLabel = computed(() =>
  new Intl.DateTimeFormat(intlLocale.value, { year: 'numeric', month: 'long' }).format(viewMonth.value),
)

const grid = computed<Date[]>(() => {
  const first = startOfMonth(viewMonth.value)
  const lead = (first.getDay() - weekStart.value + 7) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
})

// 选中预览：仅起点已选 + 悬停时，预览 [起点, 悬停] 区间。
const span = computed<{ lo: Date | null; hi: Date | null }>(() => {
  const f = fromD.value
  const tEnd = toD.value
  if (f && !tEnd && hoverD.value) {
    return hoverD.value < f ? { lo: hoverD.value, hi: f } : { lo: f, hi: hoverD.value }
  }
  return { lo: f, hi: tEnd }
})

function dayMeta(d: Date) {
  const { lo, hi } = span.value
  const isStart = sameDay(d, lo)
  const isEnd = sameDay(d, hi)
  const single = isStart && isEnd
  const inRange = !!lo && !!hi && !single && d.getTime() > lo.getTime() && d.getTime() < hi.getTime()
  return {
    iso: toISO(d),
    day: d.getDate(),
    outside: d.getMonth() !== viewMonth.value.getMonth(),
    today: sameDay(d, today),
    selected: isStart || isEnd,
    isStart: isStart && !single,
    isEnd: isEnd && !single,
    inRange,
  }
}

function pickDay(d: Date) {
  const f = fromD.value
  const tEnd = toD.value
  if (!f || (f && tEnd)) {
    // 开新区间：起点落定，清空终点。
    emit('update:from', toISO(d))
    emit('update:to', '')
    return
  }
  // 已有起点、无终点 → 落定区间（点在起点前则交换），完成即收起。
  if (d.getTime() < f.getTime()) {
    emit('update:to', toISO(f))
    emit('update:from', toISO(d))
  } else {
    emit('update:to', toISO(d))
  }
  close()
}

function gotoToday() {
  viewMonth.value = startOfMonth(today)
}
function clearRange() {
  emit('update:from', '')
  emit('update:to', '')
}
function shiftMonth(n: number) {
  viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + n, 1)
}

// 触发区两段文案（无值显占位）。
const fromText = computed(() => props.from || props.fromLabel || t('common.startDate', '开始日期'))
const toText = computed(() => props.to || props.toLabel || t('common.endDate', '结束日期'))

// ── 定位（复用 HcSelect：fixed + 下方空间不足则上翻）──
function updatePosition() {
  const el = triggerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const flipUp = spaceBelow < 360 && rect.top > spaceBelow
  popStyle.value = {
    position: 'fixed',
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`,
    ...(flipUp ? { bottom: `${window.innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` }),
  }
}

async function openPop() {
  if (open.value || props.disabled) return
  viewMonth.value = startOfMonth(fromD.value || toD.value || today)
  open.value = true
  await nextTick()
  updatePosition()
}
function close() {
  if (!open.value) return
  open.value = false
  hoverD.value = null
}
function toggle() {
  if (open.value) close()
  else openPop()
}

function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (triggerRef.value?.contains(target) || popRef.value?.contains(target)) return
  close()
}
function onScrollOrResize() {
  if (open.value) updatePosition()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside, true)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})

// 父级清空筛选时收起。
watch([() => props.from, () => props.to], () => {
  if (open.value && !props.from && !props.to) hoverD.value = null
})
</script>

<template>
  <div ref="triggerRef" class="hc-drp" :class="{ 'hc-drp--disabled': disabled }">
    <button
      type="button"
      class="hc-drp__field"
      :class="{ 'hc-drp__field--empty': !from, 'hc-drp__field--active': open }"
      :data-testid="fromTestid || undefined"
      :disabled="disabled"
      :aria-label="fromLabel"
      @click="toggle"
      @keydown="onKeydown"
    >
      <CalendarDays :size="13" class="hc-drp__icon" />
      <span>{{ fromText }}</span>
    </button>
    <span class="hc-drp__tilde">~</span>
    <button
      type="button"
      class="hc-drp__field"
      :class="{ 'hc-drp__field--empty': !to, 'hc-drp__field--active': open }"
      :data-testid="toTestid || undefined"
      :disabled="disabled"
      :aria-label="toLabel"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span>{{ toText }}</span>
    </button>

    <Teleport to="body">
      <Transition name="hc-drp-pop">
        <div v-if="open" ref="popRef" class="hc-drp__pop" :style="popStyle" role="dialog">
          <div class="hc-drp__head">
            <button type="button" class="hc-drp__nav" :aria-label="t('common.prevMonth', '上一月')" @click="shiftMonth(-1)">
              <ChevronLeft :size="16" />
            </button>
            <span class="hc-drp__title">{{ headerLabel }}</span>
            <button type="button" class="hc-drp__nav" :aria-label="t('common.nextMonth', '下一月')" @click="shiftMonth(1)">
              <ChevronRight :size="16" />
            </button>
          </div>

          <div class="hc-drp__week">
            <span v-for="(w, i) in weekdayLabels" :key="i" class="hc-drp__wd">{{ w }}</span>
          </div>

          <div class="hc-drp__grid">
            <button
              v-for="(d, i) in grid"
              :key="i"
              type="button"
              class="hc-drp__cell"
              :class="{
                'hc-drp__cell--range': dayMeta(d).inRange,
                'hc-drp__cell--start': dayMeta(d).isStart,
                'hc-drp__cell--end': dayMeta(d).isEnd,
              }"
              @click="pickDay(d)"
              @mouseenter="hoverD = d"
              @mouseleave="hoverD = null"
            >
              <span
                class="hc-drp__day"
                :class="{
                  'hc-drp__day--outside': dayMeta(d).outside,
                  'hc-drp__day--today': dayMeta(d).today && !dayMeta(d).selected,
                  'hc-drp__day--selected': dayMeta(d).selected,
                }"
                >{{ dayMeta(d).day }}</span
              >
            </button>
          </div>

          <div class="hc-drp__foot">
            <button type="button" class="hc-drp__link" @click="gotoToday">{{ t('common.today', '今天') }}</button>
            <button type="button" class="hc-drp__link hc-drp__link--muted" @click="clearRange">
              {{ t('common.clear', '清除') }}
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-drp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hc-drp__field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 12px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-primary);
  background: var(--hc-bg-input);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md, 10px);
  cursor: pointer;
  transition: border-color 0.15s var(--hc-ease-out, ease), background 0.15s, box-shadow 0.15s;
}
.hc-drp__field:hover:not(:disabled) {
  border-color: var(--hc-border-hl);
}
.hc-drp__field--active {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-drp__field--empty {
  color: var(--hc-text-muted);
}
.hc-drp__icon {
  color: var(--hc-text-muted);
  flex-shrink: 0;
}
.hc-drp__tilde {
  font-size: 12px;
  color: var(--hc-text-muted);
}
.hc-drp--disabled {
  opacity: 0.55;
  pointer-events: none;
}
</style>

<style>
/* 弹层 Teleport 到 body —— 非 scoped。 */
.hc-drp__pop {
  z-index: var(--hc-z-popover, 9200);
  width: 272px;
  padding: 12px;
  border-radius: var(--hc-radius-lg, 14px);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-elevated);
  backdrop-filter: blur(var(--hc-blur-heavy, 40px));
  box-shadow: var(--hc-shadow-float);
}
.hc-drp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.hc-drp__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}
.hc-drp__nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--hc-radius-sm, 8px);
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.hc-drp__nav:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.hc-drp__week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 2px;
}
.hc-drp__wd {
  text-align: center;
  font-size: 11px;
  font-weight: 500;
  color: var(--hc-text-muted);
  padding: 4px 0;
}
.hc-drp__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.hc-drp__cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
}
/* 连续区间带：中间填满，端点半边（端点圆点压在其上）。 */
.hc-drp__cell--range {
  background: var(--hc-accent-subtle);
}
.hc-drp__cell--start {
  background: linear-gradient(to right, transparent 50%, var(--hc-accent-subtle) 50%);
}
.hc-drp__cell--end {
  background: linear-gradient(to left, transparent 50%, var(--hc-accent-subtle) 50%);
}
.hc-drp__day {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-primary);
  transition: background 0.12s, color 0.12s, box-shadow 0.12s;
}
.hc-drp__cell:hover .hc-drp__day:not(.hc-drp__day--selected) {
  background: var(--hc-bg-hover);
}
.hc-drp__day--outside {
  color: var(--hc-text-muted);
  opacity: 0.5;
}
.hc-drp__day--today {
  box-shadow: inset 0 0 0 1px var(--hc-accent);
  color: var(--hc-accent);
  font-weight: 600;
}
.hc-drp__day--selected {
  background: var(--hc-accent);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 6px rgba(63, 143, 212, 0.35);
}
.hc-drp__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--hc-border-subtle);
}
.hc-drp__link {
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-accent);
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 2px 4px;
}
.hc-drp__link:hover {
  text-decoration: underline;
}
.hc-drp__link--muted {
  color: var(--hc-text-muted);
}
.hc-drp-pop-enter-active,
.hc-drp-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.hc-drp-pop-enter-from,
.hc-drp-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
