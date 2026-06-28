/**
 * HcDateRangePicker —— 边界与高级场景（在 7 基础 + 21 场景之上的第三层）。
 * 五组：① 弹层定位（下方空间不足上翻 / 水平钳制 / 常规下挂）② 跨月区间带 + 导航保持选中
 *       ③ 选择分支全枚举（双端已选重开新 / 仅终点 / 仅终点再点 / 点起点自身）
 *       ④ 闰年·年界·精确 ISO ⑤ a11y / 监听清理 / 第三 locale。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import HcDateRangePicker from '../HcDateRangePicker.vue'

function i18n(locale = 'zh-CN') {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: { 'zh-CN': zhCN, zh: zhCN, en: enUS, 'ug-CN': ugCN },
  })
}
function mountPicker(props: Record<string, unknown> = {}, locale = 'zh-CN') {
  return mount(HcDateRangePicker, { props, global: { plugins: [i18n(locale)] } })
}
function lastEmit(w: ReturnType<typeof mountPicker>, name: string): unknown[] | undefined {
  const e = w.emitted(name) as unknown[][] | undefined
  return e ? e[e.length - 1] : undefined
}
function popEl(): HTMLElement | null {
  return document.body.querySelector('.hc-drp__pop')
}
function dayCell(n: number, outside = false): HTMLElement | null {
  for (const c of Array.from(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell'))) {
    const span = c.querySelector('.hc-drp__day')
    const isOut = !!span?.classList.contains('hc-drp__day--outside')
    if (span?.textContent?.trim() === String(n) && isOut === outside) return c as HTMLElement
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
function mockRect(el: HTMLElement, r: Partial<DOMRect>) {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...r, toJSON: () => ({}) }) as DOMRect
}

describe('HcDateRangePicker · 弹层定位', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.innerHeight = 768
    window.innerWidth = 1024
  })
  afterEach(() => (document.body.innerHTML = ''))

  it('下方空间不足 → 上翻定位（bottom 定位、无 top）', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    mockRect(w.element as HTMLElement, { top: 690, bottom: 700, left: 100, width: 180 }) // spaceBelow=68<360, top>68
    await open(w)
    const p = popEl()!
    expect(p.style.bottom).not.toBe('')
    expect(p.style.top).toBe('')
    w.unmount()
  })

  it('下方空间充足 → 常规下挂（top 定位）', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    mockRect(w.element as HTMLElement, { top: 90, bottom: 100, left: 100, width: 180 }) // spaceBelow=668>360
    await open(w)
    const p = popEl()!
    expect(p.style.top).toBe('106px') // bottom 100 + 6
    expect(p.style.bottom).toBe('')
    w.unmount()
  })

  it('靠右边缘 → 水平 left 钳制进视口（innerWidth-288）', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    mockRect(w.element as HTMLElement, { top: 90, bottom: 100, left: 2000, width: 180 })
    await open(w)
    expect(popEl()!.style.left).toBe('736px') // 1024-288
    w.unmount()
  })

  it('靠左越界 → left 钳制到最小 8px', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    mockRect(w.element as HTMLElement, { top: 90, bottom: 100, left: -50, width: 180 })
    await open(w)
    expect(popEl()!.style.left).toBe('8px')
    w.unmount()
  })
})

describe('HcDateRangePicker · 跨月区间 + 导航保持选中', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('跨月区间：6 月视图里属于区间的「次月溢出日」也带 range', async () => {
    const w = mountPicker({ from: '2026-06-25', to: '2026-07-05' })
    await open(w)
    expect(title()).toContain('6') // 视图月仍是起点所在的 6 月
    const julyOne = dayCell(1, true) // 6 月格末尾溢出的 7 月 1 日（outside）
    expect(julyOne).not.toBeNull()
    expect(julyOne!.classList.contains('hc-drp__cell--range')).toBe(true)
    w.unmount()
  })

  it('翻月离开再翻回 → 选中端点高亮仍在（选中绑 props 非视图）', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '2026-06-20' })
    await open(w)
    expect(dayCell(10)!.classList.contains('hc-drp__cell--start')).toBe(true)
    const navs = () => document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')
    ;(navs()[1] as HTMLElement).click() // → 7 月
    await flushPromises()
    ;(navs()[0] as HTMLElement).click() // ← 回 6 月
    await flushPromises()
    expect(dayCell(10)!.classList.contains('hc-drp__cell--start')).toBe(true)
    expect(dayCell(20)!.classList.contains('hc-drp__cell--end')).toBe(true)
    w.unmount()
  })
})

describe('HcDateRangePicker · 选择分支全枚举', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('双端已选 → 再点任一日 = 开新区间（新起点、清终点），不收起', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '2026-06-20' })
    await open(w)
    dayCell(25)!.click()
    await flushPromises()
    expect(lastEmit(w, 'update:from')).toEqual(['2026-06-25'])
    expect(lastEmit(w, 'update:to')).toEqual([''])
    expect(popEl()).not.toBeNull() // 开新区间不收起，等第二次点击
    w.unmount()
  })

  it('仅终点有值（无起点）→ 视图落在终点月、终点日呈选中', async () => {
    const w = mountPicker({ from: '', to: '2026-06-20' })
    await open(w)
    expect(title()).toContain('6')
    expect(dayCell(20)!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    w.unmount()
  })

  it('仅终点有值时点击某日 → 起点落定、清空孤儿终点', async () => {
    const w = mountPicker({ from: '', to: '2026-06-20' })
    await open(w)
    dayCell(10)!.click()
    await flushPromises()
    expect(lastEmit(w, 'update:from')).toEqual(['2026-06-10'])
    expect(lastEmit(w, 'update:to')).toEqual([''])
    w.unmount()
  })

  it('已有起点、点击起点自身 → 落成单日区间（终点=起点）并收起', async () => {
    const w = mountPicker({ from: '2026-06-10', to: '' })
    await open(w)
    dayCell(10)!.click()
    await flushPromises()
    expect(lastEmit(w, 'update:to')).toEqual(['2026-06-10'])
    expect(popEl()).toBeNull()
    w.unmount()
  })
})

describe('HcDateRangePicker · 闰年·年界·精确 ISO', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('闰年 2 月 29（2028）可显示并选中，网格仍 42 格', async () => {
    const w = mountPicker({ from: '2028-02-29', to: '2028-02-29' })
    await open(w)
    expect(title()).toContain('2028')
    const c = dayCell(29)
    expect(c).not.toBeNull()
    expect(c!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell').length).toBe(42)
    w.unmount()
  })

  it('非闰年 2 月（2026）无 29 日格', async () => {
    const w = mountPicker({ from: '2026-02-10' })
    await open(w)
    expect(dayCell(29)).toBeNull() // 当月无 29（28 天）
    w.unmount()
  })

  it('12 月 31 日：触发区精确显示 ISO + 当月选中', async () => {
    const w = mountPicker({ from: '2026-12-31', to: '2026-12-31' })
    expect(w.findAll('.hc-drp__field')[0]!.text()).toContain('2026-12-31')
    await open(w)
    expect(title()).toContain('12')
    expect(dayCell(31)!.querySelector('.hc-drp__day')!.classList.contains('hc-drp__day--selected')).toBe(true)
    w.unmount()
  })

  it('连点下一月 12 次 = 次年同月', async () => {
    const w = mountPicker({ from: '2026-06-10' })
    await open(w)
    for (let i = 0; i < 12; i++) {
      ;(document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')[1] as HTMLElement).click()
    }
    await flushPromises()
    expect(title()).toContain('2027')
    w.unmount()
  })
})

describe('HcDateRangePicker · a11y / 监听清理 / 第三 locale', () => {
  beforeEach(() => (document.body.innerHTML = ''))
  afterEach(() => (document.body.innerHTML = ''))

  it('a11y：弹层 role=dialog、字段 aria-label、导航按钮 aria-label 本地化', async () => {
    const w = mountPicker({ from: '2026-06-10', fromLabel: '起始', toLabel: '结束' })
    expect(w.findAll('.hc-drp__field')[0]!.attributes('aria-label')).toBe('起始')
    expect(w.findAll('.hc-drp__field')[1]!.attributes('aria-label')).toBe('结束')
    await open(w)
    expect(popEl()!.getAttribute('role')).toBe('dialog')
    const navs = document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')
    expect(navs[0]!.getAttribute('aria-label')).toBe(zhCN.common.prevMonth)
    expect(navs[1]!.getAttribute('aria-label')).toBe(zhCN.common.nextMonth)
    w.unmount()
  })

  it('卸载时移除全局 mousedown/scroll/resize 监听（无泄漏）', () => {
    const docSpy = vi.spyOn(document, 'removeEventListener')
    const winSpy = vi.spyOn(window, 'removeEventListener')
    const w = mountPicker({ from: '2026-06-10' })
    w.unmount()
    const docEvents = docSpy.mock.calls.map((c) => c[0])
    const winEvents = winSpy.mock.calls.map((c) => c[0])
    expect(docEvents).toContain('mousedown')
    expect(winEvents).toContain('scroll')
    expect(winEvents).toContain('resize')
    docSpy.mockRestore()
    winSpy.mockRestore()
    w.unmount()
  })

  it('hover 但起止皆空 → 无区间预览、无崩溃', async () => {
    const w = mountPicker({ from: '', to: '' })
    await open(w)
    dayCell(15)!.dispatchEvent(new MouseEvent('mouseenter'))
    await flushPromises()
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell--range').length).toBe(0)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__day--selected').length).toBe(0)
    w.unmount()
  })

  it('维语(ug-CN，RTL/第三 locale)正常渲染 7 星期 + 42 日格，不崩溃', async () => {
    const w = mountPicker({ from: '2026-06-10' }, 'ug-CN')
    await open(w)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__wd').length).toBe(7)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell').length).toBe(42)
    expect(title()).not.toBe('')
    w.unmount()
  })
})
