import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12PracticeCandidateSelectionModal from '../components/K12PracticeCandidateSelectionModal.vue'
import K12RecordsView from '../views/K12RecordsView.vue'
import type { PracticeCandidateSelectionDTO } from '@/api/k12'

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

function selection(
  over: Partial<PracticeCandidateSelectionDTO> = {},
): PracticeCandidateSelectionDTO {
  return {
    selection_id: 'selection-a',
    source_mistake_id: 'a',
    target_set_record_id: 'basket-1',
    state: 'open',
    next_batch_ordinal: 1,
    revision: 1,
    candidates: [
      {
        candidate_id: 'original-a',
        candidate_kind: 'original',
        batch_ordinal: 0,
        candidate_ordinal: 0,
        normalized_content_hash: 'sha256:original',
        state: 'ready',
        question_markdown: '3.8×3=?',
      },
    ],
    ...over,
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
  k12EnsureWeeklyPracticePlan: (...args: unknown[]) => h.ensureWeeklyPlan(...args),
  k12DeferMistakeThisWeek: (...args: unknown[]) => h.deferWeeklyItem(...args),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({ state: 'available', source_mistake_id: recordID }),
    ),
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

describe('K12RecordsView · 共享候选选择后原子加入练习集', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.openSelection.mockReset().mockResolvedValue(selection())
    h.generateBatch.mockReset()
    h.commitSelection.mockReset()
    h.ensureWeeklyPlan.mockReset().mockResolvedValue(weeklyPlan())
    h.deferWeeklyItem.mockReset().mockResolvedValue({ ok: true, replayed: false })
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('点击唯一入口恢复同一 selection，并按冻结年级与教材打开批准弹窗', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    expect(h.openSelection).toHaveBeenCalledWith('a', {
      agent: 'mingming',
      idempotency_key: expect.stringMatching(/^desktop-practice-candidate-open:mingming:a:/),
      grade: '五年级下 · 人教版',
      textbook: '人教版',
    })
    const modal = wrapper.getComponent(K12PracticeCandidateSelectionModal)
    expect(modal.props('open')).toBe(true)
    expect(modal.props('originalQuestion')).toBe('3.8×3=?')
    expect(document.body.textContent).toContain('选择加入练习集的题目')
    expect(document.body.textContent).toContain('原题')
  })

  it('原题固定选中、已存在项禁用，多选 ready 后只提交新增 candidate IDs 一次', async () => {
    h.openSelection.mockResolvedValue(
      selection({
        candidates: [
          ...selection().candidates,
          {
            candidate_id: 'variant-ready',
            candidate_kind: 'variant',
            batch_ordinal: 1,
            candidate_ordinal: 1,
            normalized_content_hash: 'sha256:ready',
            state: 'ready',
            question_markdown: '4.2×3=?',
          },
          {
            candidate_id: 'variant-existing',
            candidate_kind: 'variant',
            batch_ordinal: 1,
            candidate_ordinal: 2,
            normalized_content_hash: 'sha256:existing',
            state: 'already_in_set',
            question_markdown: '5.2×3=?',
          },
        ],
      }),
    )
    h.commitSelection.mockResolvedValue({
      selection: selection({ state: 'committed', revision: 2 }),
      added_count: 2,
      already_present: ['variant-existing'],
      replayed: false,
    })
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    const inputs = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('.candidate-modal input[type="checkbox"]'),
    )
    expect(inputs).toHaveLength(3)
    expect(inputs[0]?.checked).toBe(true)
    expect(inputs[2]?.disabled).toBe(true)
    inputs[1]?.click()
    await flushPromises()

    const commit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="practice-candidate-commit"]',
    )
    expect(commit?.textContent).toContain('加入练习集（2）')
    commit?.click()
    await flushPromises()

    expect(h.commitSelection).toHaveBeenCalledWith('selection-a', {
      agent: 'mingming',
      revision: 1,
      candidate_ids: ['original-a', 'variant-ready'],
      idempotency_key: expect.stringMatching(
        /^desktop-practice-candidate-commit:mingming:selection-a:/,
      ),
    })
    expect(h.commitSelection).toHaveBeenCalledTimes(1)
  })

  it('每批生成复用 selection revision；单条失败不阻塞原题和其他 ready 候选', async () => {
    h.generateBatch.mockResolvedValue(
      selection({
        revision: 2,
        next_batch_ordinal: 2,
        candidates: [
          ...selection().candidates,
          {
            candidate_id: 'variant-failed',
            candidate_kind: 'variant',
            batch_ordinal: 1,
            candidate_ordinal: 1,
            normalized_content_hash: 'sha256:failed',
            state: 'failed',
            question_markdown: '',
            failure_message: '模型暂不可用',
          },
          {
            candidate_id: 'variant-ready',
            candidate_kind: 'variant',
            batch_ordinal: 1,
            candidate_ordinal: 2,
            normalized_content_hash: 'sha256:ready',
            state: 'ready',
            question_markdown: '4.2×3=?',
          },
        ],
      }),
    )
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    document.body
      .querySelector<HTMLButtonElement>('[data-testid="practice-candidate-generate"]')
      ?.click()
    await flushPromises()

    expect(h.generateBatch).toHaveBeenCalledWith('selection-a', {
      agent: 'mingming',
      revision: 1,
      idempotency_key: expect.stringMatching(
        /^desktop-practice-candidate-batch:mingming:selection-a:/,
      ),
    })
    expect(document.body.textContent).toContain('生成失败')
    expect(document.body.textContent).toContain('模型暂不可用')
    expect(document.body.textContent).toContain('4.2×3=?')
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-testid="practice-candidate-commit"]')
        ?.disabled,
    ).toBe(false)
  })

  it('BUG-20260725-010/011：open 丢失成功响应后重试复用同一幂等键，成功后才轮换', async () => {
    h.openSelection
      .mockReset()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce(selection())
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()
    const firstKey = h.openSelection.mock.calls[0]?.[1]?.idempotency_key

    document.body.querySelector<HTMLButtonElement>('[data-governed-button="k12-retry"]')?.click()
    await flushPromises()
    const retryKey = h.openSelection.mock.calls[1]?.[1]?.idempotency_key
    expect(retryKey).toBe(firstKey)

    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click()
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()
    expect(h.openSelection.mock.calls[2]?.[1]?.idempotency_key).not.toBe(firstKey)
  })

  it('BUG-20260725-010/011：batch 丢失成功响应后重试复用同一幂等键，成功后才轮换', async () => {
    h.generateBatch
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(selection({ revision: 2 }))
      .mockResolvedValueOnce(selection({ revision: 3 }))
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    const generate = () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="practice-candidate-generate"]')
        ?.click()
    generate()
    await flushPromises()
    const firstKey = h.generateBatch.mock.calls[0]?.[1]?.idempotency_key
    generate()
    await flushPromises()
    expect(h.generateBatch.mock.calls[1]?.[1]?.idempotency_key).toBe(firstKey)

    generate()
    await flushPromises()
    expect(h.generateBatch.mock.calls[2]?.[1]?.idempotency_key).not.toBe(firstKey)
  })

  it('BUG-20260725-011：commit 丢失成功响应后重试复用同一幂等键，成功后才轮换', async () => {
    const committed = {
      selection: selection({ state: 'committed', revision: 2 }),
      added_count: 1,
      already_present: [],
      replayed: true,
    }
    h.commitSelection
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(committed)
      .mockResolvedValueOnce(committed)
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()

    const commit = () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="practice-candidate-commit"]')
        ?.click()
    commit()
    await flushPromises()
    const firstKey = h.commitSelection.mock.calls[0]?.[1]?.idempotency_key
    commit()
    await flushPromises()
    expect(h.commitSelection.mock.calls[1]?.[1]?.idempotency_key).toBe(firstKey)

    await wrapper.get('[data-testid="mistake-practice-a"]').trigger('click')
    await flushPromises()
    commit()
    await flushPromises()
    expect(h.commitSelection.mock.calls[2]?.[1]?.idempotency_key).not.toBe(firstKey)
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
