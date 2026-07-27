import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecordList from '@/shell/records/RecordList.vue'
import K12RecordsView from '../views/K12RecordsView.vue'

// 旧“再练一道”弹层与 /review/retry 已在 2026-07-25 退役；本文件只保留仍有效的错题详情回归。
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
        due_at: 1710000000,
      },
    ],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockResolvedValue({ state: 'available', source_mistake_id: 'a' }),
  k12MarkMastered: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
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
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
  k12ListCreativeWorks: vi.fn().mockResolvedValue({ items: [] }),
}))

function render() {
  return mount(K12RecordsView, {
    props: {
      agentId: 'mingming',
      agentName: '小明',
      grade: '五年级下',
      target: 'mistakes',
    },
    global: {
      plugins: [
        createPinia(),
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          fallbackLocale: 'zh-CN',
          messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
        }),
      ],
    },
  })
}

describe('BUG-20260712 #2 错题详情', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('点详情后渲染题目、知识点、错因和状态', async () => {
    const wrapper = render()
    await flushPromises()
    wrapper.findComponent(RecordList).vm.$emit('action', {
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
    const modal = wrapper.get('[data-testid="mistake-detail"]')
    expect(modal.text()).toContain('3.8×3')
    expect(modal.text()).toContain('小数乘法')
    expect(modal.text()).toContain('算成了 10.4')
    expect(modal.text()).toContain('待复习')
  })
})
