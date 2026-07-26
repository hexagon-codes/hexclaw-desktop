import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

/**
 * 2026-07-25 产品裁决：
 * 错题列表的一次「加入练习集」直接创建服务端持久化异步任务；题面、答案、质量门和装篮
 * 都由服务端完成。桌面端只投影 available/pending/joined/failed/re_add/hidden，
 * 不再弹“再练一道 → 显示答案 → 再点加入练习集”的第二套临时流程。
 */
const h = vi.hoisted(() => {
  const mistake = {
    record_id: 'a',
    question: '3.8×3=?',
    knowledge_point: '小数乘法',
    error_cause: '进位',
    subject: '数学',
    status: 'new',
    version: 0,
    due_at: 1710000000,
  }
  return {
    mistake,
    state: {
      state: 'available',
      source_mistake_id: 'a',
    } as Record<string, unknown>,
    getGeneration: vi.fn(),
    startGeneration: vi.fn(),
    retryGeneration: vi.fn(),
  }
})

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [h.mistake] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistake] }),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12GetMistakePracticeGeneration: (...args: unknown[]) => h.getGeneration(...args),
  k12StartMistakePracticeGeneration: (...args: unknown[]) => h.startGeneration(...args),
  k12RetryMistakePracticeGeneration: (...args: unknown[]) => h.retryGeneration(...args),
  k12RecordMistake: vi.fn(),
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
      agentName: '小明的辅导老师',
      grade: '五年级下 · 人教版',
      modelRoute: { provider: 'hexclaw-gpt', model: 'gpt-5.6-sol', capability: 'text' },
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

describe('K12RecordsView · 一键异步加入练习集', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.state = { state: 'available', source_mistake_id: 'a' }
    h.getGeneration.mockReset().mockImplementation(() => Promise.resolve({ ...h.state }))
    h.startGeneration.mockReset()
    h.retryGeneration.mockReset()
  })

  it('available 一次点击即冻结年级/教材/界面模型并进入 pending，不显示旧答案弹窗', async () => {
    h.startGeneration.mockResolvedValue({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'job-1',
    })
    const wrapper = render()
    await flushPromises()

    const action = wrapper.get('[data-testid="mistake-practice-a"]')
    expect(action.text()).toBe('加入练习集')
    await action.trigger('click')
    await flushPromises()

    expect(h.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'mingming',
        record_id: 'a',
        grade: '五年级下',
        textbook: '人教版',
        difficulty: 'same',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      }),
    )
    expect(wrapper.get('[data-testid="mistake-practice-state-a"]').text()).toBe(
      '已加入 · 正在出题…',
    )
    expect(wrapper.find('.k12retry').exists()).toBe(false)
  })

  it('joined 从服务端恢复为已加入并提供查看新题，不依赖内存成功标记', async () => {
    h.state = {
      state: 'joined',
      source_mistake_id: 'a',
      practice_set_id: 'basket-1',
      practice_item_id: 'item-1',
    }
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="mistake-practice-state-a"]').text()).toBe(
      '✓ 已加入练习集',
    )
    expect(wrapper.get('[data-testid="mistake-practice-view-a"]').text()).toBe('查看新题')
  })

  it('failed 只显示原地重试，重试复用既有持久化任务', async () => {
    h.state = {
      state: 'failed',
      source_mistake_id: 'a',
      generation_job_id: 'job-1',
      failure_reason: 'provider unavailable',
    }
    h.retryGeneration.mockResolvedValue({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'job-1',
    })
    const wrapper = render()
    await flushPromises()

    const action = wrapper.get('[data-testid="mistake-practice-a"]')
    expect(action.text()).toBe('出题失败，重试')
    await action.trigger('click')
    await flushPromises()

    expect(h.retryGeneration).toHaveBeenCalledWith('mingming', 'a')
    expect(wrapper.get('[data-testid="mistake-practice-state-a"]').text()).toBe(
      '已加入 · 正在出题…',
    )
  })
})
