/**
 * K12 学情面板高保真契约。
 *
 * 唯一 UI 权威：hexclaw-docs/prototype/app.html
 * - 模板：2352-2359
 * - 样式：1230-1268
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12InsightPanel from '../views/K12InsightPanel.vue'

const api = vi.hoisted(() => ({
  report: vi.fn(),
  mistakes: vi.fn(),
  queue: vi.fn(),
  practice: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: (...args: unknown[]) => api.mistakes(...args),
  k12ReviewQueue: (...args: unknown[]) => api.queue(...args),
  k12InsightReport: (...args: unknown[]) => api.report(...args),
  k12ListPracticeSets: (...args: unknown[]) => api.practice(...args),
}))

const reportFixture = {
  trend: { total: 11, mastered: 6, reviewing: 4, retried: 1, archived: 0 },
  weak_top3: [
    { knowledge_point: '简易方程', count: 5 },
    { knowledge_point: '小数乘法', count: 3 },
    { knowledge_point: '多边形面积', count: 1 },
  ],
  month_new_mistakes: 9,
  review_completion_rate: 0.78,
  consecutive_fail_kps: ['简易方程'],
  suggestion: '先做 2 道等式性质热身，再进入本周复习卷中的方程题。',
}

const mistake = (id: string) => ({
  record_id: id,
  question: `题目 ${id}`,
  knowledge_point: '简易方程',
  error_cause: '等式性质未掌握',
  status: 'new',
  version: 1,
  subject: '数学',
})

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(props: { agentId?: string; grade?: string } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(K12InsightPanel, {
    props: { agentId: 'ming', grade: '五年级', ...props },
    global: { plugins: [pinia, makeI18n()] },
  })
}

beforeEach(() => {
  api.report.mockReset().mockResolvedValue(reportFixture)
  api.mistakes.mockReset().mockResolvedValue({ items: [mistake('m1')] })
  api.queue.mockReset().mockResolvedValue({
    items: [
      mistake('m1'),
      mistake('m2'),
      mistake('m3'),
      mistake('m4'),
      mistake('m5'),
      mistake('m6'),
    ],
  })
  api.practice.mockReset().mockResolvedValue({
    items: [
      { record_id: 'p1', status: 'draft', items: [{}, {}, {}, {}] },
      { record_id: 'p2', status: 'draft', items: [{}, {}] },
    ],
  })
})

describe('app.html 学情指标与行动语义', () => {
  it('按原型顺序显示本学期错题、证据已掌握、本周待复习、练习集待打印', async () => {
    const wrapper = render()
    await flushPromises()

    const tiles = wrapper.findAll('.k12ins__tile')
    expect(tiles.map((tile) => tile.text())).toEqual([
      '11条本学期错题',
      '6条证据已掌握',
      '6条本周待复习',
      '6道练习集待打印',
    ])
    expect(wrapper.text()).not.toContain('新增错题')
    expect(wrapper.text()).not.toContain('复习完成率')
  })

  it('优先处理、连续挫败和本周行动卡使用真实报告与练习集数据', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="insight-priority-title"]').text()).toBe('需要优先处理')
    expect(wrapper.get('[data-testid="insight-priority-note"]').text()).toBe(
      '按知识点错误次数 · 点击下钻错题',
    )
    const priorityBars = wrapper
      .get('[data-testid="insight-priority-card"]')
      .findAll('[data-testid="insight-weak-bar"]')
    expect(priorityBars).toHaveLength(3)
    expect(priorityBars.map((bar) => bar.get('.k12ins__fill').attributes('style'))).toEqual([
      'width: 83%;',
      'width: 50%;',
      'width: 17%;',
    ])

    const setback = wrapper.get('[data-testid="insight-setback-action"]')
    expect(setback.text()).toContain('连续挫败 · 简易方程')
    expect(setback.text()).toContain(reportFixture.suggestion)
    expect(setback.text()).toContain('去本周复习 ›')

    const weekly = wrapper.get('[data-testid="insight-week-action"]')
    expect(weekly.text()).toContain('本周行动已经排好')
    expect(weekly.text()).toContain('6 道题已加入练习集')
    expect(weekly.text()).toContain('去打印 ›')
  })

  it('四项指标、优先条和两张行动卡均发出确定的 navigate 事件', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="insight-tile-semester"]').trigger('click')
    await wrapper.get('[data-testid="insight-tile-mastered"]').trigger('click')
    await wrapper.get('[data-testid="insight-tile-week"]').trigger('click')
    await wrapper.get('[data-testid="insight-tile-practice"]').trigger('click')
    await wrapper.findAll('[data-testid="insight-weak-bar"]')[0]!.trigger('click')
    await wrapper.get('[data-testid="insight-fail-cta"]').trigger('click')
    await wrapper.get('[data-testid="insight-print-cta"]').trigger('click')

    expect(wrapper.emitted('navigate')).toEqual([
      [{ target: 'mistakes', subject: '', status: 'all' }],
      [{ target: 'mistakes', subject: '', status: 'mastered' }],
      [{ target: 'week', subject: '', status: 'all' }],
      [{ target: 'practiceSets', subject: '', status: 'all' }],
      [{ target: 'mistakes', subject: '数学', status: 'all' }],
      [{ target: 'week', subject: '', status: 'all' }],
      [{ target: 'practiceSets', subject: '', status: 'all' }],
    ])
  })
})

describe('真实 loading / error / empty 状态', () => {
  it('请求未完成时只显示 loading，不把尚未返回的数据误报为空态', async () => {
    let resolveReport!: (value: typeof reportFixture) => void
    api.report.mockReturnValue(
      new Promise((resolve) => {
        resolveReport = resolve
      }),
    )

    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="insight-loading"]').attributes('role')).toBe('status')
    expect(wrapper.find('[data-testid="insight-empty"]').exists()).toBe(false)
    expect(wrapper.find('.k12ins__tiles').exists()).toBe(false)

    resolveReport(reportFixture)
    await flushPromises()
    expect(wrapper.find('[data-testid="insight-loading"]').exists()).toBe(false)
    expect(wrapper.find('.k12ins__tiles').exists()).toBe(true)
  })

  it('报告失败显示可重试错误，不与空态或成功内容混排', async () => {
    api.report.mockRejectedValue(new Error('学情加载失败'))
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="insight-error"]').text()).toContain('学情加载失败')
    expect(wrapper.find('[data-testid="insight-empty"]').exists()).toBe(false)
    expect(wrapper.find('.k12ins__tiles').exists()).toBe(false)
  })

  it('所有请求成功但无证据时才显示空态，且不宣称行动已排好', async () => {
    api.report.mockResolvedValue({
      ...reportFixture,
      trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
      weak_top3: [],
      consecutive_fail_kps: [],
      suggestion: '',
    })
    api.mistakes.mockResolvedValue({ items: [] })
    api.queue.mockResolvedValue({ items: [] })
    api.practice.mockResolvedValue({ items: [] })

    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="insight-empty"]').text()).toContain(
      '还没有足够的批改与复练证据',
    )
    expect(wrapper.find('[data-testid="insight-week-action"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="insight-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="insight-error"]').exists()).toBe(false)
  })
})

describe('多孩实例隔离', () => {
  it('切换孩子后，较晚返回的旧练习集响应不能覆盖当前孩子的待打印数', async () => {
    let resolveMing!: (value: {
      items: Array<{ record_id: string; status: string; items: object[] }>
    }) => void
    api.practice.mockImplementation((agentId: string) => {
      if (agentId === 'ming') {
        return new Promise((resolve) => {
          resolveMing = resolve
        })
      }
      return Promise.resolve({
        items: [{ record_id: 'hong-p1', status: 'draft', items: [{}, {}, {}] }],
      })
    })

    const wrapper = render({ agentId: 'ming' })
    await wrapper.setProps({ agentId: 'hong' })
    await flushPromises()
    expect(wrapper.get('[data-testid="insight-tile-practice"]').text()).toBe('3道练习集待打印')

    resolveMing({
      items: [{ record_id: 'ming-p1', status: 'draft', items: [{}, {}, {}, {}, {}, {}] }],
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="insight-tile-practice"]').text()).toBe('3道练习集待打印')
    expect(api.practice).toHaveBeenNthCalledWith(1, 'ming', 'draft')
    expect(api.practice).toHaveBeenNthCalledWith(2, 'hong', 'draft')
  })
})

describe('app.html 学情几何契约', () => {
  const source = readFileSync(resolve(__dirname, '../views/K12InsightPanel.vue'), 'utf8')

  it('保留 170px 指标列、14px 瓷片、640px 优先卡与右置 CTA', () => {
    expect(source).toMatch(/\.k12ins\s*\{[^}]*flex:\s*1[^}]*overflow:\s*auto/s)
    expect(source).not.toMatch(/\.k12ins\s*\{[^}]*max-width/s)
    expect(source).toMatch(/\.k12ins__h\s*\{[^}]*font-size:\s*15px/s)
    expect(source).toContain('minmax(170px, 1fr)')
    expect(source).toMatch(/\.k12ins__tile\s*\{[^}]*border-radius:\s*14px/s)
    expect(source).toMatch(/\.k12ins__tile\s*\{[^}]*padding:\s*14px 16px/s)
    expect(source).toMatch(/\.k12ins__priority\s*\{[^}]*max-width:\s*640px/s)
    expect(source).toMatch(/\.k12ins__action\s*\{[^}]*display:\s*flex/s)
  })
})
