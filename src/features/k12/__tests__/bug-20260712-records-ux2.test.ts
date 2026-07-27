import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecordList from '@/shell/records/RecordList.vue'
import K12RecordsView from '../views/K12RecordsView.vue'
import { MISTAKE_SCHEMA } from '../schemas'
import type { RecordCollectionView } from '@/contracts'

// 第二批 UX 治本（真机 · 2026-07-12）：
//  项-5 空态设计（无本周该练 → 等重正向空态卡 + 全部错题默认展开；积累空态卡）。
//  项-6a 悬空「数学·」芯片（知识点为空 → 只显「数学」不带「·」尾巴）。

const h = vi.hoisted(() => ({ mistakes: [] as unknown[], accum: [] as unknown[], queue: [] as unknown[] }))

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('mingming'),
  k12ListMistakes: vi.fn().mockImplementation(() => Promise.resolve({ items: h.mistakes })),
  k12ReviewQueue: vi.fn().mockImplementation(() => Promise.resolve({ items: h.queue })),
  k12MarkMastered: vi.fn(),
  k12DeleteMistake: vi.fn(),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, recordID: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: recordID })),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: [], suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockImplementation(() => Promise.resolve({ items: h.accum })),
}))

function i18nInst() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}
function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明', grade: '五年级下' },
    global: { plugins: [createPinia(), i18nInst()] },
  })
}

describe('项-6a 悬空「数学·」芯片：知识点为空只显学科', () => {
  it('knowledge_point 结尾带「·」时芯片去掉尾巴分隔符', () => {
    const view: RecordCollectionView = {
      collection: '错题本', schemaVersion: '1',
      items: [{ recordId: 'a', agentId: 'm', collection: '错题本', schemaVersion: '1', status: 'new', fields: { question: 'Q', knowledge_point: '数学·', error_cause: '' }, version: 0, dueAt: null }],
      reviewQueue: [], statusCounts: {},
    }
    const w = mount(RecordList, { props: { schema: MISTAKE_SCHEMA, view }, global: { plugins: [i18nInst()] } })
    const chip = w.find('.rl-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('数学') // RED：修前显「数学·」
    expect(chip.text()).not.toContain('·')
  })
})

describe('项-5 本周该练：服务端计划是唯一投影，旧本地队列空态退役', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.accum = []; h.queue = [] })

  it('本地复习队列空 → 仍渲染服务端计划，不渲染旧空态卡；全部错题可独立直达', async () => {
    const now = Math.floor(Date.now() / 1000)
    h.mistakes = [{ record_id: 'a', question: '3.8×3', knowledge_point: '小数乘法', error_cause: 'x', status: 'new', version: 0, due_at: now + 86400 }]
    h.queue = []
    const w = render()
    await flushPromises()
    expect(w.find('.weekly-hero').exists()).toBe(true)
    expect(w.find('[data-testid="review-empty-card"]').exists()).toBe(false)
    expect(w.find('.rl-review').exists()).toBe(false)
    await w.findAll('.seg button').find((b) => b.text() === '全部错题')!.trigger('click')
    await flushPromises()
    expect(w.find('.k12mistakes').classes()).not.toContain('k12mistakes--collapsed')
  })

  it('本地复习队列有项 → 不把它重新投影成旧行动卡（服务端计划仍是唯一数据源）', async () => {
    const now = Math.floor(Date.now() / 1000)
    h.mistakes = [{ record_id: 'a', question: '3.8×3', knowledge_point: '小数乘法', error_cause: 'x', status: 'new', version: 0, due_at: now - 10 }]
    h.queue = [{ record_id: 'a', question: '3.8×3', knowledge_point: '小数乘法', error_cause: 'x', status: 'new', version: 0, due_at: now - 10, subject: '数学', review_kind: 'verify' }]
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="review-empty-card"]').exists()).toBe(false)
    expect(w.find('.rl-review').exists(), '旧本地行动卡不得恢复').toBe(false)
    expect(w.find('.weekly-hero').exists()).toBe(true)
  })
})

describe('积累空态（Bug-20260713：对齐原型 rc1——克制列表占位，非大居中卡）', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.mistakes = []; h.queue = []; h.accum = [] })

  it('积累本为空 → 克制列表占位（有文案），入口走上方常驻 bar 的「＋记到积累本」', async () => {
    const w = render()
    await flushPromises()
    // 切到「积累」tab（按文本选，不依赖索引——20260718 学习档案加了练习集/作品 tab 后索引变了）
    await w.findAll('.seg button').find((b) => b.text() === '积累')!.trigger('click')
    await flushPromises()
    // 原型无大居中卡：空态是一行占位（非裸悬空、非 marketing 卡），且不再叠自带 CTA 按钮
    const card = w.find('[data-testid="accum-empty-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('积累本还空着')
    expect(w.find('[data-testid="accum-empty-cta"]').exists()).toBe(false)
    // 记录入口=上方 bar 常驻按钮（空/非空都在），点开手动记录表单
    const add = w.find('[data-testid="accum-add-open"]')
    expect(add.exists()).toBe(true)
    await add.trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="accum-add-content"]').exists()).toBe(true)
  })
})
