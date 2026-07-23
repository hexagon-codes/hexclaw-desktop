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

// UX 收口（真机 · 2026-07-12）：
//  UX-1 「他会了」下放到全部错题档案行 + 详情弹层（此前只在到期复习队列块，常空）。
//  UX-2 再练结果弹层不显验算徽章（练习题不是批改，unverifiable 徽章让家长困惑）。
//  UX-3 详情弹层内克制删除（二次确认，数据纠错）。

const h = vi.hoisted(() => ({
  retry: null as unknown as (...a: unknown[]) => Promise<unknown>,
  markMastered: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [{ record_id: 'a', question: '3.8×3 = ?', knowledge_point: '小数乘法', error_cause: '算成了 10.4', status: 'new', version: 0, due_at: null }],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: (...args: unknown[]) => h.markMastered(...args),
  k12DeleteMistake: (...args: unknown[]) => h.del(...args),
  k12ReviewRetry: (...args: unknown[]) => h.retry(...args),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 }, weak_top3: [], month_new_mistakes: 1, review_completion_rate: 0, consecutive_fail_kps: [], suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
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

describe('UX-1 「家长确认已会」下放到全部错题档案行', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function viewWith(status: string): RecordCollectionView {
    return {
      collection: '错题本', schemaVersion: '1',
      items: [{ recordId: 'a', agentId: 'm', collection: '错题本', schemaVersion: '1', status, fields: { question: 'Q', knowledge_point: 'kp', error_cause: 'ec' }, version: 0, dueAt: null }],
      reviewQueue: [], statusCounts: {},
    }
  }

  it('未掌握档案行渲染「家长确认已会」并 emit markMastered', async () => {
    const w = mount(RecordList, { props: { schema: MISTAKE_SCHEMA, view: viewWith('new') }, global: { plugins: [i18nInst()] } })
    const btns = w.findAll('.rl-row .rl-btn').filter((b) => b.text().includes('家长确认已会'))
    expect(btns.length).toBe(1) // RED：修前档案行无该动作（20260718 §4.11 文案收敛「家长确认已会」）
    const masteredBtn = btns[0]
    if (!masteredBtn) throw new Error('前置：未找到「家长确认已会」按钮')
    await masteredBtn.trigger('click')
    const evs = w.emitted('action') as unknown[][] | undefined
    expect(evs?.some((e) => (e[0] as { id: string }).id === 'markMastered')).toBe(true)
  })

  it('已掌握档案行不再显示「家长确认已会」（幂等）', () => {
    const w = mount(RecordList, { props: { schema: MISTAKE_SCHEMA, view: viewWith('mastered') }, global: { plugins: [i18nInst()] } })
    const btns = w.findAll('.rl-row .rl-btn').filter((b) => b.text().includes('家长确认已会'))
    expect(btns.length).toBe(0)
  })
})

describe('UX-1 详情弹层「家长确认已会」动作', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.retry = vi.fn(); h.markMastered = vi.fn().mockResolvedValue({ ok: true }) })

  it('详情弹层含「家长确认已会」→ 调 mark-mastered 并关弹层', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: { recordId: 'a', version: 0, status: 'new', fields: { question: '3.8×3 = ?', knowledge_point: '数学·小数乘法', error_cause: '算成了 10.4' } },
    })
    await flushPromises()
    const btn = w.find('[data-testid="detail-mark-mastered"]')
    expect(btn.exists()).toBe(true) // RED：修前详情弹层无该动作
    await btn.trigger('click')
    await flushPromises()
    expect(h.markMastered).toHaveBeenCalled()
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(false) // 关弹层
  })
})

describe('UX-2 再练结果弹层不显验算徽章', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('再练结果 badge 不渲染（练习题非批改）', async () => {
    h.retry = () => Promise.resolve({ solution: '解：x=14', badge: 'unverifiable', verdict: 'unverifiable' })
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', { id: 'practiceAgain', record: { recordId: 'a', version: 0 } })
    await flushPromises()
    const modal = w.find('.k12retry')
    expect(modal.exists()).toBe(true)
    // RED：修前 <span class="pill pill-green">{{ retry.badge }}</span> 会显 unverifiable
    expect(modal.find('.pill').exists()).toBe(false)
    expect(modal.text()).not.toContain('unverifiable')
  })
})

describe('UX-3 详情弹层克制删除 + 二次确认', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.retry = vi.fn(); h.del = vi.fn().mockResolvedValue({ ok: true }) })

  it('详情→删除→确认→调 delete 并关弹层', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: { recordId: 'a', version: 0, status: 'new', fields: { question: '3.8×3 = ?', knowledge_point: '数学·小数乘法', error_cause: '算成了 10.4' } },
    })
    await flushPromises()
    const delBtn = w.find('[data-testid="detail-delete"]')
    expect(delBtn.exists()).toBe(true) // RED：修前无删除入口
    await delBtn.trigger('click')
    await flushPromises()
    // 二次确认对话框（复用 ConfirmDialog，Teleport 到 body）
    const confirmBtn = document.body.querySelector('.hc-dialog__btn--danger') as HTMLButtonElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()
    expect(h.del).toHaveBeenCalledWith('mingming', 'a')
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(false)
  })

  it('删除不是首屏主按钮（用 ghost/danger 次级样式，非 btn-primary）', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: { recordId: 'a', version: 0, status: 'new', fields: { question: 'Q', knowledge_point: 'kp', error_cause: 'ec' } },
    })
    await flushPromises()
    const delBtn = w.find('[data-testid="detail-delete"]')
    expect(delBtn.classes()).not.toContain('btn-primary')
  })
})
