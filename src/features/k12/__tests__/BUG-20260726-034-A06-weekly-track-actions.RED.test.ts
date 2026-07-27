import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import * as k12Api from '@/api/k12'
import k12Zh from '../i18n/zh-CN'
import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'

const h = vi.hoisted(() => ({
  post: vi.fn(),
}))

vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>()
  return {
    ...original,
    apiPost: h.post,
  }
})

type ApiClient = (...args: unknown[]) => Promise<unknown>

const basePlan = {
  plan_id: 'weekly-31',
  agent: 'mingming',
  revision: 4,
  iso_week_year: 2026,
  iso_week_number: 31,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-27T00:00:00+08:00',
  week_end: '2026-08-02T23:59:59+08:00',
  local_start_date: '2026-07-27',
  local_end_date: '2026-08-02',
  status: 'draft',
  settings_revision: 2,
  curriculum_progress_revision: 3,
  tracks: [],
  created_at: '2026-07-27T08:00:00Z',
  updated_at: '2026-07-27T08:00:00Z',
}

const settings = {
  agent: 'mingming',
  revision: 2,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true,
  textbook_consolidation_enabled: true,
  arithmetic_warmup_enabled: true,
  arithmetic_minutes: 2,
  created_at: '2026-07-27T08:00:00Z',
  updated_at: '2026-07-27T08:00:00Z',
}

const arithmeticItem = {
  item_id: 'arithmetic-1',
  position: 1,
  plan_section: 'arithmetic_warmup',
  source_kind: 'arithmetic',
  generation_method: 'generated',
  source_ref: 'batch-1',
  verification: {
    status: 'verified',
    evidence_refs: ['batch-1'],
  },
  prompt_markdown: '计算 0.8 × 25。',
}

const textbookItem = {
  item_id: 'textbook-1',
  position: 1,
  plan_section: 'textbook_consolidation',
  source_kind: 'textbook',
  generation_method: 'retrieval_grounded',
  source_ref: 'segment-1',
  verification: {
    status: 'verified',
    evidence_refs: ['segment-1'],
    textbook_binding_id: 'binding-1',
    unit_id: 'unit-1',
    verified_page_from: 8,
    verified_page_to: 8,
  },
  prompt_markdown: '把 2/3 和 3/5 通分。',
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function normalizedText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function accessibleName(element: HTMLElement) {
  return (
    normalizedText(element.getAttribute('aria-label')) ||
    normalizedText(element.textContent)
  )
}

function buttons() {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('button,[role="button"]'),
  )
}

function buttonNamed(name: string) {
  return buttons().find((button) => accessibleName(button) === name)
}

function renderTracks(tracks: any[]) {
  return mount(K12WeeklyPracticePanel, {
    props: {
      progress: null,
      settings: settings as any,
      plan: { ...basePlan, tracks } as any,
      history: [],
      output: null,
      loading: false,
      busy: false,
      error: '',
      deliveryLabel: '发送到手机',
      deliveryDisabled: false,
    },
    global: { plugins: [i18n()] },
    attachTo: document.body,
  })
}

function arithmeticBatch(
  state:
    | 'preparing'
    | 'ready'
    | 'in_progress'
    | 'completed'
    | 'failed_retryable'
    | 'failed_terminal',
) {
  return {
    batch_id: 'batch-1',
    state,
    item_count: state === 'ready' || state === 'in_progress' || state === 'completed' ? 1 : 0,
    content_digest: 'sha256:batch-1',
    retryable: state === 'failed_retryable',
    failure_message:
      state === 'failed_retryable'
        ? '口算生成暂时不可用，请重试'
        : state === 'failed_terminal'
          ? '口算生成失败，请检查默认模型设置'
          : '',
    created_at: '2026-07-27T08:00:00Z',
    updated_at: '2026-07-27T08:01:00Z',
    ...(state === 'completed'
      ? { completed_at: '2026-07-27T08:02:00Z' }
      : {}),
  }
}

function arithmeticTrack(
  batch: ReturnType<typeof arithmeticBatch> | null,
) {
  const hasItems =
    batch?.state === 'ready' ||
    batch?.state === 'in_progress' ||
    batch?.state === 'completed'
  return {
    plan_section: 'arithmetic_warmup',
    status: 'ready',
    failure_message: '',
    items: hasItems ? [arithmeticItem] : [],
    arithmetic_batch: batch,
  }
}

function apiClient(name: string) {
  const client = (k12Api as unknown as Record<string, unknown>)[name]
  expect(
    client,
    `[BUG-20260726-034][A06] 缺少 HTTP client 导出 ${name}`,
  ).toBeTypeOf('function')
  return client as ApiClient
}

describe('[BUG-20260726-034] A06 weekly track action contracts', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    h.post.mockReset()
  })

  it.each([
    ['preparing', arithmeticBatch('preparing'), '正在准备口算…', true],
    ['ready', arithmeticBatch('ready'), '开始口算', false],
    ['in_progress', arithmeticBatch('in_progress'), '继续口算', false],
    ['completed', arithmeticBatch('completed'), '再来一组', false],
    [
      'failed_retryable',
      arithmeticBatch('failed_retryable'),
      '重试生成 10 道',
      false,
    ],
  ])(
    '[BUG-20260726-034][A06] maps arithmetic_batch %s to its exact approved action',
    (_state, batch, label, disabled) => {
      renderTracks([arithmeticTrack(batch)])

      const action = buttonNamed(label)
      expect(
        action,
        `[BUG-20260726-034][A06] arithmetic_batch=${_state} 缺少“${label}”`,
      ).toBeDefined()
      expect(
        (action as HTMLButtonElement).disabled ||
          action?.getAttribute('aria-disabled') === 'true',
      ).toBe(disabled)
    },
  )

  it('[BUG-20260726-034][A06] exposes terminal arithmetic failure without a retry action', () => {
    const batch = arithmeticBatch('failed_terminal')
    renderTracks([arithmeticTrack(batch)])

    expect(normalizedText(document.body.textContent)).toContain(
      batch.failure_message,
    )
    expect(buttonNamed('重试')).toBeUndefined()
  })

  it.each([
    ['ready', [], []],
    ['stale', ['按新进度更新'], []],
    ['failed', ['重试'], ['教材同步练习生成暂时不可用']],
  ])(
    '[BUG-20260726-034][A06] maps textbook_consolidation %s to its only valid recovery action',
    (status, expectedActions, messages) => {
      renderTracks([
        {
          plan_section: 'textbook_consolidation',
          status,
          failure_message:
            status === 'failed' ? '教材同步练习生成暂时不可用' : '',
          items: status === 'ready' ? [textbookItem] : [],
          arithmetic_batch: null,
        },
      ])

      const bodyText = normalizedText(document.body.textContent)
      const actionNames = ['按新进度更新', '重试']
      expect({
        visibleActions: actionNames.filter((name) => buttonNamed(name)),
        visibleMessages: messages.filter((message) => bodyText.includes(message)),
      }).toEqual({
        visibleActions: expectedActions,
        visibleMessages: messages,
      })
    },
  )

  it('[BUG-20260726-034][A06] posts create/start/retry commands to the frozen arithmetic batch resources', async () => {
    h.post.mockResolvedValue({ batch: arithmeticBatch('ready'), replayed: false })

    await apiClient('k12CreateWeeklyArithmeticBatch')(
      'weekly-31',
      4,
      2,
      'create-batch-1',
    )
    await apiClient('k12StartWeeklyArithmeticBatch')(
      'mingming',
      'batch-1',
      'start-batch-1',
    )
    await apiClient('k12RetryWeeklyArithmeticBatch')(
      'mingming',
      'batch-1',
      'retry-batch-1',
    )

    expect(h.post).toHaveBeenNthCalledWith(
      1,
      '/api/k12/weekly-practice/plans/weekly-31/arithmetic-batches',
      {
        plan_revision: 4,
        item_count: 2,
        idempotency_key: 'create-batch-1',
      },
    )
    expect(h.post).toHaveBeenNthCalledWith(
      2,
      '/api/k12/weekly-practice/arithmetic-batches/batch-1/start',
      {
        agent: 'mingming',
        idempotency_key: 'start-batch-1',
      },
    )
    expect(h.post).toHaveBeenNthCalledWith(
      3,
      '/api/k12/weekly-practice/arithmetic-batches/batch-1/retry',
      {
        agent: 'mingming',
        idempotency_key: 'retry-batch-1',
      },
    )
  })

  it('[BUG-20260726-034][A06] submits one idempotent batch attempt to its batch resource', async () => {
    const response = {
      attempt: {
        attempt_id: 'attempt-1',
        batch_id: 'batch-1',
        item_id: 'arithmetic-1',
        assessment_id: 'assessment-1',
        result: 'wrong',
        verification_evidence: { expected: '20', received: '18' },
        mistake_record_id: 'mistake-1',
        review_scheduled: true,
        created_at: '2026-07-27T08:03:00Z',
      },
      replayed: false,
    }
    h.post.mockResolvedValue(response)

    await expect(
      apiClient('k12SubmitWeeklyArithmeticAttempt')(
        'mingming',
        'batch-1',
        'arithmetic-1',
        '18',
        'attempt-1',
      ),
    ).resolves.toBe(response)

    expect(h.post).toHaveBeenCalledExactlyOnceWith(
      '/api/k12/weekly-practice/arithmetic-batches/batch-1/attempts',
      {
        agent: 'mingming',
        item_id: 'arithmetic-1',
        student_answer: '18',
        idempotency_key: 'attempt-1',
      },
    )
    expect(Object.keys(response).sort()).toEqual(['attempt', 'replayed'])
    expect(Object.keys(response.attempt).sort()).toEqual([
      'assessment_id',
      'attempt_id',
      'batch_id',
      'created_at',
      'item_id',
      'mistake_record_id',
      'result',
      'review_scheduled',
      'verification_evidence',
    ])
  })

  it('[BUG-20260726-034][A06] refreshes stale and failed textbook tracks through the same checkpoint command', async () => {
    const response = { plan: basePlan, replayed: false }
    h.post.mockResolvedValue(response)

    await expect(
      apiClient('k12RefreshWeeklyPracticeTextbookTrack')(
        'mingming',
        'weekly-31',
        4,
        'refresh-textbook-1',
      ),
    ).resolves.toBe(response)

    expect(h.post).toHaveBeenCalledExactlyOnceWith(
      '/api/k12/weekly-practice/plans/weekly-31/tracks/textbook_consolidation/refresh',
      {
        agent: 'mingming',
        expected_revision: 4,
        idempotency_key: 'refresh-textbook-1',
      },
    )
  })
})
