import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => {
  const mistake = {
    record_id: 'a',
    question: '3.8×3=?',
    knowledge_point: '小数乘法',
    error_cause: '进位',
    subject: '数学',
    status: 'scheduled',
    review_state: 'scheduled',
    version: 0,
    due_at: 1710000000,
  }
  return {
    mistake,
    generation: {
      state: 'available',
      source_mistake_id: 'a',
    } as Record<string, unknown>,
    getGeneration: vi.fn(),
    startGeneration: vi.fn(),
    retryGeneration: vi.fn(),
    openSelection: vi.fn(),
    generateBatch: vi.fn(),
    commitSelection: vi.fn(),
    ensureWeeklyPlan: vi.fn(),
    deferWeeklyItem: vi.fn(),
  }
})

function weeklyPlan() {
  return {
    replayed: false,
    plan: {
      plan_id: 'weekly-31',
      agent: 'mingming',
      revision: 1,
      iso_week_year: 2026,
      iso_week_number: 31,
      timezone: 'Asia/Shanghai',
      week_start: '2026-07-27T00:00:00+08:00',
      week_end: '2026-08-02T23:59:59+08:00',
      local_start_date: '2026-07-27',
      local_end_date: '2026-08-02',
      status: 'draft',
      settings_revision: 1,
      tracks: [
        {
          plan_section: 'due_review',
          status: 'ready',
          items: [
            {
              item_id: 'weekly-a',
              position: 1,
              plan_section: 'due_review',
              source_kind: 'mistake',
              generation_method: 'original',
              source_ref: 'a',
              verification: { status: 'verified', evidence_refs: ['小数乘法'] },
              prompt_markdown: '3.8×3=?',
            },
          ],
        },
      ],
      created_at: '2026-07-27T00:00:00Z',
      updated_at: '2026-07-27T00:00:00Z',
    },
  }
}

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('mingming'),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [h.mistake] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistake] }),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12OpenPracticeCandidateSelection: (...args: unknown[]) => h.openSelection(...args),
  k12GeneratePracticeCandidateBatch: (...args: unknown[]) => h.generateBatch(...args),
  k12CommitPracticeCandidateSelection: (...args: unknown[]) => h.commitSelection(...args),
  k12GetMistakePracticeGeneration: (...args: unknown[]) => h.getGeneration(...args),
  k12StartMistakePracticeGeneration: (...args: unknown[]) => h.startGeneration(...args),
  k12RetryMistakePracticeGeneration: (...args: unknown[]) => h.retryGeneration(...args),
  k12EnsureWeeklyPracticePlan: (...args: unknown[]) => h.ensureWeeklyPlan(...args),
  k12DeferMistakeThisWeek: (...args: unknown[]) => h.deferWeeklyItem(...args),
  k12RecordMistake: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 1, total: 1 },
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

function render(target: 'week' | 'mistakes' = 'mistakes') {
  return mount(K12RecordsView, {
    attachTo: document.body,
    props: {
      agentId: 'mingming',
      agentName: '小明的辅导助手',
      grade: '五年级下 · 人教版',
      target,
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

describe('K12RecordsView · 一键持久任务加入练习集', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.generation = { state: 'available', source_mistake_id: 'a' }
    h.getGeneration
      .mockReset()
      .mockImplementation((_agent: string, recordID: string) =>
        Promise.resolve({ ...h.generation, source_mistake_id: recordID }),
      )
    h.startGeneration.mockReset()
    h.retryGeneration.mockReset()
    h.openSelection.mockReset()
    h.generateBatch.mockReset()
    h.commitSelection.mockReset()
    h.ensureWeeklyPlan.mockReset().mockResolvedValue(weeklyPlan())
    h.deferWeeklyItem.mockReset().mockResolvedValue({ ok: true, replayed: false })
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('错题一次点击冻结边界并立即创建 durable task，候选 API 与 Modal 均为零', async () => {
    h.startGeneration.mockResolvedValue({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'generation-a',
    })
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    expect(h.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'mingming',
        record_id: 'a',
        idempotency_key: expect.stringMatching(/^desktop-single-practice:mingming:a:/),
        grade: '五年级下',
        textbook: '人教版',
        difficulty: 'same',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      }),
    )
    expect(h.startGeneration).toHaveBeenCalledTimes(1)
    expect(h.openSelection).not.toHaveBeenCalled()
    expect(h.generateBatch).not.toHaveBeenCalled()
    expect(h.commitSelection).not.toHaveBeenCalled()
    expect(document.body.querySelectorAll('[data-testid="practice-candidate-modal"]')).toHaveLength(
      0,
    )
    expect(wrapper.get('[data-testid="mistake-practice-a"]').text()).toBe('已加入 · 正在出题…')
    wrapper.unmount()
  })

  it('本周逐题与全部错题复用同一 start 合同，零候选交互', async () => {
    h.startGeneration.mockResolvedValue({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'generation-a',
    })
    const wrapper = render('week')
    await flushPromises()

    await wrapper.get('[data-testid="weekly-practice-a"]').trigger('click')
    await flushPromises()

    expect(h.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'mingming',
        record_id: 'a',
        idempotency_key: expect.stringMatching(/^desktop-single-practice:mingming:a:/),
        grade: '五年级下',
        textbook: '人教版',
        difficulty: 'same',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      }),
    )
    expect(h.startGeneration).toHaveBeenCalledTimes(1)
    expect(h.openSelection).not.toHaveBeenCalled()
    expect(document.body.querySelectorAll('[data-testid="practice-candidate-modal"]')).toHaveLength(
      0,
    )
    expect(wrapper.get('[data-testid="weekly-practice-a"]').text()).toBe('已加入 · 正在出题…')
    wrapper.unmount()
  })

  it('start 与状态查询都失败时，下次点击复用同一 durable idempotency key', async () => {
    h.startGeneration.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'generation-a',
    })
    const wrapper = render()
    await flushPromises()

    h.getGeneration.mockRejectedValueOnce(new Error('status unavailable'))
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()
    const firstKey = h.startGeneration.mock.calls[0]?.[0]?.idempotency_key

    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()
    const retryKey = h.startGeneration.mock.calls[1]?.[0]?.idempotency_key
    expect(retryKey).toBe(firstKey)
    expect(wrapper.get('[data-testid="mistake-practice-a"]').text()).toBe('已加入 · 正在出题…')
    wrapper.unmount()
  })

  it('start 响应丢失但 GET 已见 pending 时不重复创建任务', async () => {
    h.startGeneration.mockRejectedValueOnce(new Error('response lost'))
    const wrapper = render()
    await flushPromises()

    h.getGeneration.mockResolvedValueOnce({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'generation-a',
    })
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    expect(h.startGeneration).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="mistake-practice-a"]').text()).toBe('已加入 · 正在出题…')
    expect(wrapper.get('[data-testid="mistake-practice-a"]').element.tagName).toBe('SPAN')
    wrapper.unmount()
  })

  it('failed 只重试原 durable task，不创建新任务或候选流程', async () => {
    h.generation = {
      state: 'failed',
      source_mistake_id: 'a',
      generation_job_id: 'generation-a',
      failure_reason: 'provider unavailable',
    }
    h.retryGeneration.mockResolvedValue({
      state: 'pending',
      source_mistake_id: 'a',
      generation_job_id: 'generation-a',
    })
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="mistake-practice-a"]').text()).toBe('出题失败 · 重试')
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    expect(h.retryGeneration).toHaveBeenCalledWith('mingming', 'a')
    expect(h.retryGeneration).toHaveBeenCalledTimes(1)
    expect(h.startGeneration).not.toHaveBeenCalled()
    expect(h.openSelection).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="mistake-practice-a"]').text()).toBe('已加入 · 正在出题…')
    wrapper.unmount()
  })

  it('BUG-20260725-013：defer 丢失成功响应后重试复用同一幂等键，成功后才轮换', async () => {
    h.deferWeeklyItem
      .mockReset()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ ok: true, replayed: true })
      .mockResolvedValueOnce({ ok: true, replayed: false })
    const wrapper = render('week')
    await flushPromises()

    const defer = () => wrapper.get('.weekly-item__defer').trigger('click')
    await defer()
    await flushPromises()
    const firstKey = h.deferWeeklyItem.mock.calls[0]?.[1]?.idempotency_key
    await defer()
    await flushPromises()
    expect(h.deferWeeklyItem.mock.calls[1]?.[1]?.idempotency_key).toBe(firstKey)

    await defer()
    await flushPromises()
    expect(h.deferWeeklyItem.mock.calls[2]?.[1]?.idempotency_key).not.toBe(firstKey)
  })
})
