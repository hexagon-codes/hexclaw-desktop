/**
 * 20260718 前端包 · 新交互组件测试：
 *  ① 本周清零庆祝态（§3.6 / 原型 k12WeekClearState）：本轮有「家长确认已会」清空队列 → 庆祝文案
 *     （🎉 本周清零 + 下次出卷预告）；本来就无到期 → 维持中性空态（不假庆祝）。
 *  ② 积累详情「生成默写题，加入练习集」（§3.9 检验出口）：POST /accumulation/{id}/dictation-to-basket
 *     （api/k12.ts 他会话禁改 → apiPost 内联，契约 {record_id, added}），成功后按钮幂等置灰。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => {
  const due = {
    record_id: 'a',
    question: '3.8×3',
    knowledge_point: '小数乘法',
    error_cause: '进位',
    status: 'new',
    version: 0,
    due_at: 1,
    subject: '数学',
  }
  return {
    due,
    mistakes: [due] as Array<Record<string, unknown>>,
    queue: [due] as Array<Record<string, unknown>>,
    apiPostSpy: vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({ record_id: 'ps-1', added: true }),
    accum: [
      {
        record_id: 'acc-1',
        subject: '语文',
        entry_type: '好词好句',
        content: '不积跬步无以至千里',
        status: '',
        source: '',
      },
    ],
  }
})

vi.mock('@/api/client', () => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: (...a: unknown[]) => h.apiPostSpy(...a),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockImplementation(() => Promise.resolve({ items: h.mistakes })),
  k12ReviewQueue: vi.fn().mockImplementation(() => Promise.resolve({ items: h.queue })),
  k12MarkMastered: vi.fn().mockImplementation(() => {
    // 家长确认后该题离队（后端行为投影）：队列清空、档案态置 mastered
    h.queue = []
    h.mistakes = [{ ...h.due, status: 'mastered' }]
    return Promise.resolve({ ok: true })
  }),
  k12ReviewRetry: vi.fn(),
  k12AddToBasket: vi.fn().mockResolvedValue({ record_id: 'ps-1', added: true }),
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
  k12ListCreativeWorks: vi.fn().mockResolvedValue({ items: [] }),
  k12FinalizePracticeSet: vi.fn(),
  k12RemoveFromBasket: vi.fn(),
  k12AdvancePracticeSet: vi.fn(),
  k12CancelPracticeSet: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 },
    weak_top3: [],
    month_new_mistakes: 1,
    review_completion_rate: -1,
    consecutive_fail_kps: null,
    suggestion: '',
  }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 1, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockImplementation(() => Promise.resolve({ items: h.accum })),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

describe('①（§3.6）本周清零庆祝态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.mistakes = [h.due]
    h.queue = [h.due]
    h.apiPostSpy.mockClear()
  })

  it('本轮「家长确认已会」清空队列 → 空态卡显庆祝文案（🎉 本周清零 + 下次出卷预告）', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="review-empty-card"]').exists()).toBe(false) // 前置：有队列
    const btn = w.findAll('.rl-btn').find((b) => b.text() === '家长确认已会')!
    await btn.trigger('click')
    await flushPromises()
    const card = w.find('[data-testid="review-empty-card"]')
    expect(card.exists()).toBe(true)
    expect(w.find('[data-testid="review-cleared-title"]').exists()).toBe(true)
    expect(card.text()).toContain('本周清零')
    expect(card.text()).toContain('周五 19:00')
    // 庆祝态不再显中性「本周暂无到期复习」
    expect(card.text()).not.toContain('本周暂无到期复习')
  })

  it('本来就无到期（无清零动作）→ 维持中性空态，不假庆祝', async () => {
    h.queue = []
    h.mistakes = []
    const w = render()
    await flushPromises()
    const card = w.find('[data-testid="review-empty-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('本周暂无到期复习')
    expect(card.text()).not.toContain('本周清零')
  })
})

describe('②（§3.9）积累详情「生成默写题，加入练习集」', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.mistakes = [h.due]
    h.queue = [h.due]
    h.apiPostSpy.mockClear().mockResolvedValue({ record_id: 'ps-1', added: true })
  })

  async function openAccumDetail() {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '积累')!
      .trigger('click')
    await flushPromises()
    await w.findAll('.k12accum__detail')[0]!.trigger('click')
    await flushPromises()
    return w
  }

  it('积累详情弹层有出口按钮，点按调 dictation-to-basket 端点（约定契约 {record_id, added}）', async () => {
    const w = await openAccumDetail()
    const btn = w.find('[data-testid="accum-dictation-to-basket"]')
    expect(btn.exists(), '积累详情应有「生成默写题，加入练习集」出口').toBe(true)
    expect(btn.text()).toContain('生成默写题')
    await btn.trigger('click')
    await flushPromises()
    expect(h.apiPostSpy).toHaveBeenCalledWith('/api/k12/accumulation/acc-1/dictation-to-basket', {
      agent: 'mingming',
    })
  })

  it('成功后按钮幂等：文案转「已加入练习集」并置灰，不重复调端点', async () => {
    const w = await openAccumDetail()
    const btn = w.find('[data-testid="accum-dictation-to-basket"]')
    await btn.trigger('click')
    await flushPromises()
    expect(btn.text()).toContain('已加入练习集')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    await flushPromises()
    expect(h.apiPostSpy).toHaveBeenCalledTimes(1)
  })

  it('端点失败 → 按钮保持可重试（不置灰不改文案）', async () => {
    h.apiPostSpy.mockRejectedValueOnce(new Error('后端还没就绪'))
    const w = await openAccumDetail()
    const btn = w.find('[data-testid="accum-dictation-to-basket"]')
    await btn.trigger('click')
    await flushPromises()
    expect(btn.text()).toContain('生成默写题')
    expect(btn.attributes('disabled')).toBeUndefined()
  })
})
