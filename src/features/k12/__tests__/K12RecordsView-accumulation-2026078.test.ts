import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import HcSelect from '@/components/common/HcSelect.vue'

// #4/#5（hex-test 闭环）：积累本手动记录入口 + 语/英分科过滤。
// 后端 POST /accumulation（k12AddAccumulation）真 + GET /accumulation?subject=（store BUG-3 已通），
// 但原 UI 无「记到积累本」入口、loadAccumulation 不传 subject、无学科筛选切换器。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  addSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
    weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: (agent: string, subject?: string) => h.listSpy(agent, subject),
  k12AddAccumulation: (req: unknown) => h.addSpy(req),
  k12ReviewRetry: vi.fn(),
  k12ExportMd: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

async function gotoAccum(w: ReturnType<typeof render>) {
  await w.findAll('.seg button').find((b) => b.text() === k12Zh.subTabs.accumulation)!.trigger('click')
  await flushPromises()
}

async function openAccumMore(w: ReturnType<typeof render>) {
  await w.find('.k12rec__export > button').trigger('click')
  await flushPromises()
}

describe('K12RecordsView 积累本（#4 手动记录 + #5 分科过滤）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.listSpy.mockReset().mockResolvedValue({ items: [] })
    h.addSpy.mockReset().mockResolvedValue({ record_id: 'x', created: true })
  })

  it('#5 分科过滤：点「语文」chip → 以 subject=语文 重新拉取积累本', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    h.listSpy.mockClear()

    await openAccumMore(w)
    const chip = w.find('[data-testid="accum-filter-chinese"]')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    await flushPromises()

    expect(h.listSpy).toHaveBeenCalled()
    const lastCall = h.listSpy.mock.calls[h.listSpy.mock.calls.length - 1]!
    expect(lastCall[1]).toBe('语文')
  })

  it('#5 分科过滤：点「全部」→ 不带 subject 拉全量', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    // 先切语文再切全部
    await openAccumMore(w)
    await w.find('[data-testid="accum-filter-chinese"]').trigger('click')
    await flushPromises()
    h.listSpy.mockClear()
    await openAccumMore(w)
    await w.find('[data-testid="accum-filter-all"]').trigger('click')
    await flushPromises()

    const lastCall = h.listSpy.mock.calls[h.listSpy.mock.calls.length - 1]!
    expect(lastCall[1]).toBeUndefined()
  })

  it('#4 手动记录：填表提交 → 调 k12AddAccumulation 并刷新', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    await w.find('[data-testid="accum-add-open"]').trigger('click')
    await flushPromises()

    const form = w.find('[data-testid="accum-add-form"]')
    expect(form.exists()).toBe(true)
    expect(form.classes()).toContain('k12modal')

    // 选学科英语（20260718 原型定案：类型按学科分化，切英语后类型 sync 重置为「表达积累」），
    // 再显式选「词汇积累」（学科/类型下拉走 HcSelect，D5：不再用原生 select）、填内容
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '英语')
    w.findAllComponents(HcSelect)[1]!.vm.$emit('update:modelValue', '词汇积累')
    await flushPromises()
    await w.find('[data-testid="accum-add-content"]').setValue('a piece of cake')
    h.listSpy.mockClear()
    await w.find('[data-testid="accum-add-submit"]').trigger('click')
    await flushPromises()

    expect(h.addSpy).toHaveBeenCalledTimes(1)
    const req = h.addSpy.mock.calls[0]![0]
    expect(req.agent).toBe('mingming')
    expect(req.subject).toBe('英语')
    expect(req.entry_type).toBe('词汇积累')
    expect(req.content).toBe('a piece of cake')
    // 提交后重新拉取积累本
    expect(h.listSpy).toHaveBeenCalled()
  })

  it('#4 手动记录：内容为空时提交按钮禁用', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.find('[data-testid="accum-add-open"]').trigger('click')
    await flushPromises()
    const submit = w.find('[data-testid="accum-add-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
  })

  // 引文行对齐（20260718 定案迭代 3 · 原型 #k12AccumulationList）：引文全宽首行（quote 卡形态），
  // meta 行带收藏日期 acc-date（created_at unix 秒 → MM-DD）；旧后端无 created_at 时日期不显示。
  it('引文行对齐：created_at → MM-DD 收藏日期 + quote 卡形态', async () => {
    const ts = Math.floor(new Date(2026, 6, 12, 10, 0, 0).getTime() / 1000) // 本地 07-12
    h.listSpy.mockReset().mockResolvedValue({
      items: [
        { record_id: 'q1', subject: '语文', entry_type: '好词好句', content: '时间像海绵里的水', source: '课外阅读', status: 'new', created_at: ts },
        { record_id: 'q2', subject: '英语', entry_type: '表达积累', content: 'a piece of cake', status: 'new' }, // 旧后端：无 created_at
      ],
    })
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    const rows = w.findAll('.k12accum__row--quote')
    expect(rows.length, '积累行走引文卡形态（row--quote）').toBe(2)
    // 引文正文全宽置首（b.k12accum__title），日期在 meta 行
    const first = rows[0]!
    expect(first.find('b.k12accum__title').text()).toContain('时间像海绵里的水')
    expect(first.find('[data-testid="accum-date"]').text()).toBe('07-12')
    // 无 created_at → 不渲染日期占位
    expect(rows[1]!.find('[data-testid="accum-date"]').exists()).toBe(false)
  })

  // BUG-20260712-#2：积累行「详情」走真 handler → 打开详情弹层显内容/学科/类型（不再死按钮）。
  it('积累行「详情」点击 → 打开详情弹层显内容/学科/类型', async () => {
    h.listSpy.mockReset().mockResolvedValue({
      items: [{ record_id: 'x1', subject: '英语', entry_type: '好词好句', content: 'a piece of cake', status: 'new' }],
    })
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    // 积累行只应有「详情」（无「再练」）
    const rowBtns = w.findAll('.k12accum__row .k12accum__detail').map((b) => b.text())
    expect(rowBtns).not.toContain('再练')
    await w.findAll('.k12accum__row .k12accum__detail').find((b) => b.text() === '详情')!.trigger('click')
    await flushPromises()
    const modal = w.find('[data-testid="mistake-detail"]')
    expect(modal.exists()).toBe(true)
    expect(w.find('[data-testid="detail-content"]').text()).toContain('a piece of cake')
    expect(w.find('[data-testid="detail-accum-subject"]').text()).toContain('英语')
    expect(w.find('[data-testid="detail-accum-type"]').text()).toContain('好词好句')
  })
})
