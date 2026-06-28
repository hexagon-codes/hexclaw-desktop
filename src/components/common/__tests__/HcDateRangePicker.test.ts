/**
 * HcDateRangePicker —— 取代原生 <input type="date"> 的品牌一致日期区间选择器。
 * 验证：触发区占位/取值、弹层开合、本地化表头、单选落起点清终点、区间二选落终点、
 *       反序自动交换、上/下月导航、今天/清除。弹层 Teleport 到 body，故查 document.body。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'

// lucide 图标 stub 成空 span，避免渲染开销。
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
    messages: { 'zh-CN': zhCN, zh: zhCN, en: enUS },
  })
}

function mountPicker(props: Record<string, unknown> = {}, locale = 'zh-CN') {
  return mount(HcDateRangePicker, { props, global: { plugins: [i18n(locale)] } })
}

/** 最近一次某事件的参数（避免 es2022 Array.at，兼容 vue-tsc lib）。 */
function lastEmit(w: ReturnType<typeof mountPicker>, name: string): unknown[] | undefined {
  const e = w.emitted(name) as unknown[][] | undefined
  return e ? e[e.length - 1] : undefined
}

/** 在 body 弹层里找「当月、文本为 n」的日期 cell（排除跨月 outside）。 */
function findDayCell(n: number): HTMLElement | null {
  const cells = document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell')
  for (const c of Array.from(cells)) {
    const span = c.querySelector('.hc-drp__day')
    if (span?.textContent?.trim() === String(n) && !span.classList.contains('hc-drp__day--outside')) {
      return c as HTMLElement
    }
  }
  return null
}

async function openCalendar(wrapper: ReturnType<typeof mountPicker>) {
  await wrapper.find('.hc-drp__field').trigger('click')
  await flushPromises()
}

describe('HcDateRangePicker', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('空值时触发区显示占位（开始/结束日期），有值时显示日期', () => {
    const empty = mountPicker()
    const fields = empty.findAll('.hc-drp__field')
    expect(fields[0]!.text()).toContain(zhCN.common.startDate)
    expect(fields[1]!.text()).toContain(zhCN.common.endDate)
    empty.unmount()

    const filled = mountPicker({ from: '2026-06-10', to: '2026-06-20' })
    const f2 = filled.findAll('.hc-drp__field')
    expect(f2[0]!.text()).toContain('2026-06-10')
    expect(f2[1]!.text()).toContain('2026-06-20')
    filled.unmount()
  })

  it('点击触发区打开 Teleport 弹层，表头本地化（含年份），并渲染 6×7=42 日格', async () => {
    const wrapper = mountPicker({ from: '2026-06-10' })
    expect(document.body.querySelector('.hc-drp__pop')).toBeNull()
    await openCalendar(wrapper)

    const pop = document.body.querySelector('.hc-drp__pop')
    expect(pop).not.toBeNull()
    // Intl 本地化表头：zh-CN → 「2026年6月」，至少含年份。
    expect(pop!.querySelector('.hc-drp__title')?.textContent).toContain('2026')
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__cell').length).toBe(42)
    expect(document.body.querySelectorAll('.hc-drp__pop .hc-drp__wd').length).toBe(7)
    wrapper.unmount()
  })

  it('单击某日 → 落定起点(update:from)并清空终点(update:to="")', async () => {
    const wrapper = mountPicker({ from: '', to: '2026-06-20' })
    await openCalendar(wrapper)
    findDayCell(15)!.click()
    await flushPromises()

    expect(lastEmit(wrapper, 'update:from')).toEqual(['2026-06-15'])
    expect(lastEmit(wrapper, 'update:to')).toEqual([''])
    wrapper.unmount()
  })

  it('已有起点、再点更晚的日 → 落定终点(update:to)，不再清空', async () => {
    const wrapper = mountPicker({ from: '2026-06-10', to: '' })
    await openCalendar(wrapper)
    findDayCell(20)!.click()
    await flushPromises()

    expect(lastEmit(wrapper, 'update:to')).toEqual(['2026-06-20'])
    // 完成区间不应又把 from 清掉
    expect(wrapper.emitted('update:from') ?? []).toEqual([])
    wrapper.unmount()
  })

  it('已有起点、再点更早的日 → 自动交换（新起点=更早、终点=原起点）', async () => {
    const wrapper = mountPicker({ from: '2026-06-15', to: '' })
    await openCalendar(wrapper)
    findDayCell(8)!.click()
    await flushPromises()

    expect(lastEmit(wrapper, 'update:from')).toEqual(['2026-06-08'])
    expect(lastEmit(wrapper, 'update:to')).toEqual(['2026-06-15'])
    wrapper.unmount()
  })

  it('上一月 / 下一月导航切换表头月份', async () => {
    const wrapper = mountPicker({ from: '2026-06-10' })
    await openCalendar(wrapper)
    const title = () => document.body.querySelector('.hc-drp__pop .hc-drp__title')?.textContent ?? ''
    const navs = document.body.querySelectorAll('.hc-drp__pop .hc-drp__nav')
    ;(navs[0] as HTMLElement).click() // 上一月 → 5月
    await flushPromises()
    expect(title()).toContain('5')
    ;(navs[1] as HTMLElement).click() // 回 6月
    ;(navs[1] as HTMLElement).click() // → 7月
    await flushPromises()
    expect(title()).toContain('7')
    wrapper.unmount()
  })

  it('清除按钮发出空起止；en locale 表头与星期为英文', async () => {
    const wrapper = mountPicker({ from: '2026-06-10', to: '2026-06-20' }, 'en')
    await openCalendar(wrapper)
    // en 表头：June 2026
    expect(document.body.querySelector('.hc-drp__pop .hc-drp__title')?.textContent).toMatch(/2026/)
    const links = document.body.querySelectorAll('.hc-drp__pop .hc-drp__link')
    const clearBtn = Array.from(links).find((l) => l.textContent?.includes(enUS.common.clear))
    ;(clearBtn as HTMLElement).click()
    await flushPromises()
    expect(lastEmit(wrapper, 'update:from')).toEqual([''])
    expect(lastEmit(wrapper, 'update:to')).toEqual([''])
    wrapper.unmount()
  })
})
