/**
 * HcDateRangePicker —— 场景与细节逻辑深度覆盖（在基础 7 项之上）。
 * 四组：① 交互生命周期（关闭/切换/禁用/重开复位）② 区间视觉带（端点/区间/单日/悬停预览）
 *       ③ 网格正确性（跨月弱化/跨月点击 ISO/今天环/周首日/跨年导航）④ 边界解析与响应式。
 * 弹层 Teleport 到 body，统一查 document.body。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import HcDateRangePicker from '../HcDateRangePicker.vue'

function i18n(locale = 'zh-CN') {
  return createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { 'zh-CN': zhCN, zh: zhCN, en: enUS } })
}
function mountPicker(props: Record<string, unknown> = {}, locale = 'zh-CN') {
  return mount(HcDateRangePicker, { props, global: { plugins: [i18n(locale)] } })
}
function lastEmit(w: ReturnType<typeof mountPicker>, name: string): unknown[] | undefined {
  const e = w.emitted(name) as unknown[][] | undefined
  return e ? e[e.length - 1] : undefined
}
function pop(): Element | null {
  return document.body.querySelector('.hc-drp__pop')
}
function dayCell(n: number): HTMLElement | null {
  for (const c of Array.from(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell'))) {
    const span = c.querySelector('.hc-drp__day')
    if (span?.textContent?.trim() === String(n) && !span.classList.contains('hc-drp__day--outside')) return c as HTMLElement
  }
  return null
}
function title(): string {
  return document.body.querySelector('.hc-drp__pop .hc-drp__title')?.textContent ?? ''
}
async function open(w: ReturnType<typeof mountPicker>) {
  await w.find('.hc-drp__field').trigger('click')
  await flushPromises()
}
function zhMonthLabel(y: number, m0: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date(y, m0, 1))
}

describe('HcDateRangePicker · 交互生命周期', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('Esc 键关闭弹层', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    await open(w)
    expect(pop()).not.toBeNull()
    await w.find('.hc-drp__field').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(pop()).toBeNull()
    w.unmount()
  })

  it('再次点击触发区 = 切换关闭', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    await open(w)
    expect(pop()).not.toBeNull()
    await w.find('.hc-drp__field').trigger('click')
    await flushPromises()
    expect(pop()).toBeNull()
    w.unmount()
  })

  it('点击外部（body 上的 mousedown）关闭弹层', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    await open(w)
    expect(pop()).not.toBeNull()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(pop()).toBeNull()
    w.unmount()
  })

  it('完成区间（第二次点击落终点）后自动收起', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '' })
    await open(w)
    dayCell(20)!.click()
    await flushPromises()
    expect(pop()).toBeNull()
    w.unmount()
  })

  it('disabled：字段带 disabled 且点击不打开弹层', async () => {
    const w = mountPicker({ from: '2026-06-10', disabled: true })
    expect(w.find('.hc-drp__field').attributes('disabled')).toBeDefined()
    await w.find('.hc-drp__field').trigger('click')
    await flushPromises()
    expect(pop()).toBeNull()
    w.unmount()
  })

  it('导航离开后重开 → 视图月复位到起点所在月', async () => {
    const w = mountPicker({ from: '2026-03-10' })
    await open(w)
    expect(title()).toBe(zhMonthLabel(2026, 2)) // 3 月
    ;(document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')[1] as HTMLElement).click() // → 4 月
    ;(document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')[1] as HTMLElement).click() // → 5 月
    await flushPromises()
    await w.find('.hc-drp__field').trigger('click') // 关
    await flushPromises()
    await open(w) // 重开
    expect(title()).toBe(zhMonthLabel(2026, 2)) // 复位回 3 月
    w.unmount()
  })
})

describe('HcDateRangePicker · 区间视觉带', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('多日区间：端点 cell 带 start/end，中间 cell 带 range，端点 day 带 selected', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '2026-06-20' })
    await open(w)
    expect(dayCell(10)!.classList.contains('hc-drp__cell--start')).toBe(true)
    expect(dayCell(20)!.classList.contains('hc-drp__cell--end')).toBe(true)
    expect(dayCell(15)!.classList.contains('hc-drp__cell--range')).toBe(true)
    expect(dayCell(10)!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    expect(dayCell(20)!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    // 区间外不应带 range
    expect(dayCell(9)!.classList.contains('hc-drp__cell--range')).toBe(false)
    expect(dayCell(21)!.classList.contains('hc-drp__cell--range')).toBe(false)
    w.unmount()
  })

  it('单日区间（from==to）：只有 selected，无 start/end/range 带', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '2026-06-10' })
    await open(w)
    const c = dayCell(10)!
    expect(c.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    expect(c.classList.contains('hc-drp__cell--start')).toBe(false)
    expect(c.classList.contains('hc-drp__cell--end')).toBe(false)
    expect(c.classList.contains('hc-drp__cell--range')).toBe(false)
    w.unmount()
  })

  it('悬停预览：起点已选、终点空，悬停更晚日 → 之间的日临时带 range', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '' })
    await open(w)
    dayCell(16)!.dispatchEvent(new MouseEvent('mouseenter'))
    await flushPromises()
    expect(dayCell(13)!.classList.contains('hc-drp__cell--range')).toBe(true)
    expect(dayCell(10)!.classList.contains('hc-drp__cell--start')).toBe(true)
    // 移开后预览消失
    dayCell(16)!.dispatchEvent(new MouseEvent('mouseleave'))
    await flushPromises()
    expect(dayCell(13)!.classList.contains('hc-drp__cell--range')).toBe(false)
    w.unmount()
  })

  it('悬停预览反向：悬停更早日 → 预览区间自动翻转（早=起点、原起点=终点）', async () => {
    const w = mountPicker({ from: '2026-06-15', to: '' })
    await open(w)
    dayCell(8)!.dispatchEvent(new MouseEvent('mouseenter'))
    await flushPromises()
    expect(dayCell(8)!.classList.contains('hc-drp__cell--start')).toBe(true)
    expect(dayCell(15)!.classList.contains('hc-drp__cell--end')).toBe(true)
    expect(dayCell(11)!.classList.contains('hc-drp__cell--range')).toBe(true)
    w.unmount()
  })
})

describe('HcDateRangePicker · 网格正确性', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('跨月日（前/后月）带 outside 弱化类', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    await open(w)
    const cells = document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell .hc-drp__day')
    const outside = Array.from(cells).filter((s) => s.classList.contains('hc-drp__day--outside'))
    // 6 月 30 天，42 格 → 必有 12 个跨月格
    expect(outside.length).toBe(12)
    w.unmount()
  })

  it('点击后月的跨月日 → 发出后月的 ISO（非当前视图月）', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '2026-06-15' }, 'zh-CN') // zh 周一首日：2026-06-01 是周一 → 无前导，末尾溢出到 7 月
    await open(w)
    const cells = document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell')
    ;(cells[cells.length - 1] as HTMLElement).click() // 最后一格必属下月
    await flushPromises()
    expect(String(lastEmit(w, 'update:from')?.[0])).toMatch(/^2026-07-/)
    w.unmount()
  })

  it('今天格在未选中时带 today 细环', async () => {
    const w = mountPicker() // 空值 → 视图月 = 当前月
    await open(w)
    const todayCell = dayCell(new Date().getDate())
    expect(todayCell).not.toBeNull()
    expect(todayCell!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--today')).toBe(true)
    w.unmount()
  })

  it('周首日按区域：zh 首列=周一（一），en 首列=周日（S）', async () => {
    const zh = mountPicker({ from: '2026-06-10' }, 'zh-CN')
    await open(zh)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__wd')[0]!.textContent).toBe('一')
    zh.unmount()
    document.body.innerHTML = ''
    const en = mountPicker({ from: '2026-06-10' }, 'en')
    await open(en)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__wd')[0]!.textContent).toBe('S')
    en.unmount()
  })

  it('跨年导航：1 月点上一月 → 上一年 12 月（表头年份变 2025）', async () => {
    const w = mountPicker({ from: '2026-01-10' })
    await open(w)
    expect(title()).toBe(zhMonthLabel(2026, 0)) // 2026年1月
    ;(document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')[0] as HTMLElement).click() // 上一月
    await flushPromises()
    expect(title()).toBe(zhMonthLabel(2025, 11)) // 2025年12月
    w.unmount()
  })

  it('今天快捷：从他月跳回当前月，且不发出任何选择', async () => {
    const w = mountPicker({ from: '2026-01-10' })
    await open(w)
    const links = document.body.querySelectorAll('.hc-drp__pop .hc-drp__link')
    const todayBtn = Array.from(links).find((l) => l.textContent?.includes(zhCN.common.today))
    ;(todayBtn as HTMLElement).click()
    await flushPromises()
    const now = new Date()
    expect(title()).toBe(zhMonthLabel(now.getFullYear(), now.getMonth()))
    expect(w.emitted('update:from')).toBeUndefined()
    expect(w.emitted('update:to')).toBeUndefined()
    w.unmount()
  })
})

describe('HcDateRangePicker · 边界解析与响应式', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('非法/空 from 不崩溃、视作无选择（视图回落今天月）', async () => {
    const w = mountPicker({ from: 'not-a-date', to: '' })
    await open(w)
    const now = new Date()
    expect(title()).toBe(zhMonthLabel(now.getFullYear(), now.getMonth()))
    // 无任何选中端点
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__day--selected').length).toBe(0)
    w.unmount()
  })

  it('前导零日期（2026-06-05）正确解析并选中第 5 日', async () => {
    const w = mountPicker({ from: '2026-06-05', to: '2026-06-05' })
    await open(w)
    expect(dayCell(5)!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    w.unmount()
  })

  it('props from/to 变更 → 触发区文案响应式更新', async () => {
    const w = mountPicker({ from: '', to: '' })
    const fields = () => w.findAll('.hc-drp__field')
    expect(fields()[0]!.text()).toContain(zhCN.common.startDate)
    await w.setProps({ from: '2026-06-10', to: '2026-06-20' })
    expect(fields()[0]!.text()).toContain('2026-06-10')
    expect(fields()[1]!.text()).toContain('2026-06-20')
    w.unmount()
  })

  it('触发区始终渲染「~」分隔符', () => {
    const w = mountPicker()
    expect(w.find('.hc-drp__tilde').exists()).toBe(true)
    expect(w.find('.hc-drp__tilde').text()).toBe('~')
    w.unmount()
  })

  it('网格恒为 6×7=42 格（不足月用前后月补满）', async () => {
    // 2026-02 仅 28 天，仍补满 42。
    const w = mountPicker({ from: '2026-02-10' })
    await open(w)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell').length).toBe(42)
    w.unmount()
  })
})
