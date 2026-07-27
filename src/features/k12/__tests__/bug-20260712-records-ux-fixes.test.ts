import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecordList from '@/shell/records/RecordList.vue'
import K12RecordsView from '../views/K12RecordsView.vue'
import { MISTAKE_SCHEMA } from '../schemas'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'
import type { RecordCollectionView } from '@/contracts'

// UX 收口（真机 · 2026-07-12）：
//  UX-1 「他会了」下放到全部错题档案行 + 详情弹层（此前只在到期复习队列块，常空）。
//  UX-3 详情弹层内克制删除（二次确认，数据纠错）。

const h = vi.hoisted(() => ({
  markMastered: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('mingming'),
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [
      {
        record_id: 'a',
        question: '3.8×3 = ?',
        knowledge_point: '小数乘法',
        error_cause: '算成了 10.4',
        status: 'scheduled',
        review_state: 'scheduled',
        version: 0,
        due_at: null,
      },
    ],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: (...args: unknown[]) => h.markMastered(...args),
  k12DeleteMistake: (...args: unknown[]) => h.del(...args),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockResolvedValue({ state: 'available', source_mistake_id: 'a' }),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi
    .fn()
    .mockResolvedValue({
      trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 },
      weak_top3: [],
      month_new_mistakes: 1,
      review_completion_rate: 0,
      consecutive_fail_kps: [],
      suggestion: '',
    }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18nInst() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12RecordsView, {
    props: {
      agentId: 'mingming',
      agentName: '小明',
      grade: '五年级下',
      target: 'mistakes',
    },
    global: { plugins: [createPinia(), i18nInst()] },
  })
}

describe('UX-1 「家长确认已会」下放到全部错题档案行', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function viewWith(status: string): RecordCollectionView {
    return {
      collection: '错题本',
      schemaVersion: '1',
      items: [
        {
          recordId: 'a',
          agentId: 'm',
          collection: '错题本',
          schemaVersion: '1',
          status,
          fields: { question: 'Q', knowledge_point: 'kp', error_cause: 'ec' },
          version: 0,
          dueAt: null,
        },
      ],
      reviewQueue: [],
      statusCounts: {},
    }
  }

  it('scheduled 档案行不暴露家长主观改掌握动作', () => {
    const w = mount(RecordList, {
      props: {
        schema: MISTAKE_SCHEMA,
        view: viewWith('scheduled'),
        hideMasteryAction: true,
      },
      global: { plugins: [i18nInst()] },
    })
    expect(w.findAll('.rl-row .rl-btn').some((button) => button.text().includes('家长确认已会'))).toBe(
      false,
    )
    expect(w.emitted('action')).toBeUndefined()
  })

  it('已掌握档案行不再显示「家长确认已会」（幂等）', () => {
    const w = mount(RecordList, {
      props: {
        schema: MISTAKE_SCHEMA,
        view: viewWith('mastered'),
        hideMasteryAction: true,
      },
      global: { plugins: [i18nInst()] },
    })
    const btns = w.findAll('.rl-row .rl-btn').filter((b) => b.text().includes('家长确认已会'))
    expect(btns.length).toBe(0)
  })
})

describe('UX-1 详情弹层「家长确认已会」动作', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.markMastered = vi.fn().mockResolvedValue({ ok: true })
  })

  it('详情弹层同样不暴露家长主观改掌握动作', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: {
        recordId: 'a',
        version: 0,
        status: 'scheduled',
        fields: {
          question: '3.8×3 = ?',
          knowledge_point: '数学·小数乘法',
          error_cause: '算成了 10.4',
        },
      },
    })
    await flushPromises()

    expect(w.find('[data-testid="detail-mark-mastered"]').exists()).toBe(false)
    expect(h.markMastered).not.toHaveBeenCalled()
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(true)
  })
})

describe('UX-3 详情弹层克制删除 + 二次确认', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.del = vi.fn().mockResolvedValue({ ok: true })
  })

  it('详情→删除→确认→调 delete 并关弹层', async () => {
    const w = render()
    await flushPromises()
    vi.useFakeTimers()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: {
        recordId: 'a',
        version: 0,
        status: 'scheduled',
        fields: {
          question: '3.8×3 = ?',
          knowledge_point: '数学·小数乘法',
          error_cause: '算成了 10.4',
        },
      },
    })
    await flushPromises()
    const delBtn = w.find('[data-testid="detail-delete"]')
    expect(delBtn.exists()).toBe(true) // RED：修前无删除入口
    await delBtn.trigger('click')
    await flushPromises()
    // 二次确认对话框（复用 ConfirmDialog，Teleport 到 body）
    const confirmBtn = document.body.querySelector(
      '.hc-dialog__btn--danger',
    ) as HTMLButtonElement | null
    expect(confirmBtn).toBeTruthy()
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    confirmBtn!.click()
    await flushPromises()
    expect(h.del).toHaveBeenCalledWith('mingming', 'a')
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(false)
    vi.useRealTimers()
  })

  it('删除不是首屏主按钮（用 ghost/danger 次级样式，非 btn-primary）', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: {
        recordId: 'a',
        version: 0,
        status: 'scheduled',
        fields: { question: 'Q', knowledge_point: 'kp', error_cause: 'ec' },
      },
    })
    await flushPromises()
    const delBtn = w.find('[data-testid="detail-delete"]')
    expect(delBtn.classes()).not.toContain('btn-primary')
    expect(delBtn.classes()).toContain('hc-btn-danger-ghost')
  })
})
