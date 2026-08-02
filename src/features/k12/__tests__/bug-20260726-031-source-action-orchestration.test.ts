import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  getResult: vi.fn(),
  confirm: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  tutoringTips: vi.fn(),
  sourceAction: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12DeleteMistake: vi.fn(),
  k12TutoringTips: (...args: unknown[]) => h.tutoringTips(...args),
  k12AddGrounding: vi.fn(),
  k12Grade: vi.fn(),
  k12RecordMistake: vi.fn(),
  k12Solve: vi.fn(),
  k12InsightReport: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12UploadAsset: (...args: unknown[]) => h.upload(...args),
  k12CreateImageTask: (...args: unknown[]) => h.create(...args),
  k12GetImageTask: (...args: unknown[]) => h.get(...args),
  k12GetImageTaskResult: (...args: unknown[]) => h.getResult(...args),
  k12ConfirmImageTask: (...args: unknown[]) => h.confirm(...args),
  k12RetryImageTask: (...args: unknown[]) => h.retry(...args),
  k12CancelImageTask: (...args: unknown[]) => h.cancel(...args),
  k12SubmitImageTaskProblemSourceAction: (...args: unknown[]) => h.sourceAction(...args),
  k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function problemProgress(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    problem_id: 'problem-1',
    source_number_path: ['一', '1'],
    display_label: '一. 1',
    source_state: 'awaiting_resolution',
    anchor_state: 'degraded',
    operation_state: 'prepared',
    disposition_state: 'open',
    result_projection: null,
    published_revision: 0,
    input_revision: 2,
    command_available: true,
    ...extra,
  }
}

function dispatchSnapshot(
  problem: Record<string, unknown> = problemProgress(),
  options: {
    structureVersion?: number
    snapshotRevision?: number
    coverage?: {
      state: 'full' | 'with_skips' | 'incomplete'
      total: number
      processed: number
      skipped: number
    }
  } = {},
) {
  return {
    dispatch_id: 'dispatch-progressive-wave-3',
    task_intent: 'completed_homework',
    status: 'routed',
    intent_evidence: ['answer_regions_present'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-progressive-wave-3' },
    target_projection: {
      kind: 'homework',
      stage: 'assessing',
      confirmation_state: 'confirmed',
      anchor_state: 'degraded',
      structure_version: options.structureVersion ?? 4,
      recognition: {
        subject: '数学',
        questions: [
          {
            problem_id: 'problem-1',
            source_number_path: ['一', '1'],
            display_label: '一. 1',
            question: '一. 1 题目',
            canonical_markdown: '一. 1 题目',
            knowledge_points: ['小数计算'],
            answer_state: 'present',
            student_answer: '8',
            confirmation_required: true,
            confirmation_reasons: ['source_conflict'],
          },
        ],
      },
      problems: [problem],
      coverage: options.coverage ?? {
        state: 'incomplete',
        total: 1,
        processed: 0,
        skipped: 0,
      },
      projection_revision: options.snapshotRevision ?? 8,
      final_artifact: null,
    },
    progress: { operation: 'homework', state: 'assessing' },
    version: options.snapshotRevision ?? 8,
    created_at: 1,
    updated_at: 2,
  }
}

function createResponse(problem: Record<string, unknown> = problemProgress()) {
  return {
    created: true,
    dispatch: dispatchSnapshot(problem),
  }
}

function sourceActionResponse(
  options: {
    action?: 'correct_text' | 'skip' | 'resume'
    structureVersion?: number
    inputRevision?: number
    snapshotRevision?: number
    coverage?: {
      total: number
      published: number
      skipped: number
      awaiting: number
      failed: number
      status: 'empty' | 'in_progress' | 'complete'
      projection_revision: number
    }
  } = {},
) {
  const action = options.action ?? 'skip'
  const inputRevision = options.inputRevision ?? (action === 'skip' ? 2 : 3)
  return {
    command_receipt_id: `receipt-${action}-1`,
    dispatch_id: 'dispatch-progressive-wave-3',
    problem_id: 'problem-1',
    action,
    structure_version: options.structureVersion ?? 4,
    input_revision: inputRevision,
    progressive_snapshot: {
      structure_version: options.structureVersion ?? 4,
      snapshot_revision: options.snapshotRevision ?? 9,
      problem_progress: [
        {
          problem_id: 'problem-1',
          status:
            action === 'skip' ? 'skipped' : action === 'resume' ? 'awaiting_source' : 'processing',
          input_revision: inputRevision,
          published_revision: action === 'skip' ? 1 : 0,
          current_disposition: 'current',
        },
      ],
      coverage: options.coverage ?? {
        total: 1,
        published: 0,
        skipped: action === 'skip' ? 1 : 0,
        awaiting: action === 'skip' ? 0 : 1,
        failed: 0,
        status: action === 'skip' ? 'complete' : 'in_progress',
        projection_revision: options.snapshotRevision ?? 9,
      },
    },
  }
}

const wrappers: VueWrapper[] = []

async function renderTask() {
  h.upload.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
  h.create.mockResolvedValue(createResponse())
  h.get.mockReturnValue(new Promise(() => {}))
  const wrapper = mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      grade: '五年级下',
      sessionId: 'session-progressive-wave-3',
      requestId: 'message-progressive-wave-3',
      initialImage: 'data:image/png;base64,QUJD',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  await flushPromises()
  await flushPromises()
  return wrapper
}

function buttonByName(root: Element, name: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.replace(/\s+/g, ' ').trim() === name,
    ) ?? null
  )
}

function resolver(wrapper: VueWrapper): HTMLElement {
  return wrapper.get('[data-source-issue-resolver]').element as HTMLElement
}

async function openSkipConfirmation(wrapper: VueWrapper): Promise<HTMLButtonElement> {
  const skip = buttonByName(resolver(wrapper), '跳过这题')
  expect(skip, 'the awaiting source issue must keep the approved skip action').not.toBeNull()
  skip!.click()
  await nextTick()
  const confirm = buttonByName(resolver(wrapper), '确认跳过这题')
  expect(confirm, 'skip must retain the approved confirmation boundary').not.toBeNull()
  return confirm!
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('BUG-20260726-031 · source-action Desktop orchestration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('PROG-026 sends one strict skip command and synchronously locks every source action while pending', async () => {
    const pending = deferred<ReturnType<typeof sourceActionResponse>>()
    h.sourceAction.mockReturnValue(pending.promise)
    const wrapper = await renderTask()
    const confirm = await openSkipConfirmation(wrapper)

    confirm.click()
    confirm.click()
    await nextTick()

    expect(h.sourceAction).toHaveBeenCalledTimes(1)
    expect(h.sourceAction).toHaveBeenCalledWith(
      'dispatch-progressive-wave-3',
      'problem-1',
      {
        action: 'skip',
        structure_version: 4,
        expected_input_revision: 2,
        payload: {},
      },
      expect.any(String),
      expect.anything(),
    )
    const idempotencyKey = h.sourceAction.mock.calls[0]?.[3]
    expect(idempotencyKey).toEqual(expect.any(String))
    expect(String(idempotencyKey).trim()).not.toBe('')
    const actionButtons = resolver(wrapper).querySelectorAll<HTMLButtonElement>('button')
    expect(actionButtons.length).toBeGreaterThan(0)
    expect([...actionButtons].every((button) => button.disabled)).toBe(true)
    expect(resolver(wrapper).textContent).not.toContain('已跳过 · 未判断对错')
  })

  it('PROG-027 reuses the same Idempotency-Key when the unchanged operation is retried', async () => {
    h.sourceAction
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary transport failure'), { status: 503 }),
      )
      .mockReturnValueOnce(new Promise(() => {}))
    const wrapper = await renderTask()

    ;(await openSkipConfirmation(wrapper)).click()
    await flushPromises()
    ;(await openSkipConfirmation(wrapper)).click()
    await nextTick()

    expect(h.sourceAction).toHaveBeenCalledTimes(2)
    const first = h.sourceAction.mock.calls[0]
    const retry = h.sourceAction.mock.calls[1]
    expect(first?.[0]).toBe('dispatch-progressive-wave-3')
    expect(first?.[1]).toBe('problem-1')
    expect(retry?.[0]).toBe(first?.[0])
    expect(retry?.[1]).toBe(first?.[1])
    expect(retry?.[2]).toEqual(first?.[2])
    expect(retry?.[3]).toBe(first?.[3])
  })

  it('PROG-027 refreshes the authoritative dispatch snapshot after stale 409 and never resubmits the command', async () => {
    h.sourceAction.mockRejectedValue(
      Object.assign(new Error('stale input revision'), { status: 409 }),
    )
    const wrapper = await renderTask()
    const authoritative = dispatchSnapshot(
      problemProgress({
        source_state: 'ready',
        anchor_state: 'located',
        operation_state: 'published',
        disposition_state: 'result',
        result_projection: { assessment_status: 'correct' },
        published_revision: 3,
        input_revision: 3,
        command_available: false,
      }),
      { snapshotRevision: 12 },
    )
    h.get.mockReset()
    h.get.mockResolvedValue({ dispatch: authoritative })
    ;(await openSkipConfirmation(wrapper)).click()
    await flushPromises()
    await flushPromises()

    expect(h.sourceAction).toHaveBeenCalledTimes(1)
    expect(h.get).toHaveBeenCalledTimes(1)
    expect(h.get).toHaveBeenCalledWith('mingming', 'dispatch-progressive-wave-3', expect.anything())
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('已批改')
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).not.toContain('已跳过 · 未判断对错')
  })

  it.each([
    ['422 domain rejection', Object.assign(new Error('invalid source action'), { status: 422 })],
    ['schema or identity rejection', new Error('Invalid source-action response identity')],
  ])('PROG-026 keeps the existing projection after %s', async (_name, cause) => {
    h.sourceAction.mockRejectedValue(cause)
    const wrapper = await renderTask()
    const backgroundGetCalls = h.get.mock.calls.length

    ;(await openSkipConfirmation(wrapper)).click()
    await flushPromises()
    await flushPromises()

    const problem = wrapper.get('[data-problem-id="problem-1"]')
    expect(problem.text()).toContain('等待处理题源问题')
    expect(problem.text()).not.toContain('已跳过 · 未判断对错')
    expect(h.sourceAction).toHaveBeenCalledTimes(1)
    expect(h.get).toHaveBeenCalledTimes(backgroundGetCalls)
    expect(buttonByName(resolver(wrapper), '跳过这题')?.disabled).toBe(false)
  })

  it('PROG-026 aborts the in-flight source command when the TaskShell unmounts', async () => {
    h.sourceAction.mockReturnValue(new Promise(() => {}))
    const wrapper = await renderTask()

    ;(await openSkipConfirmation(wrapper)).click()
    await nextTick()
    const signal = h.sourceAction.mock.calls[0]?.[4] as AbortSignal
    expect(signal.aborted).toBe(false)

    wrapper.unmount()

    expect(signal.aborted).toBe(true)
    expect(h.sourceAction).toHaveBeenCalledTimes(1)
  })

  it('PROG-026D keeps reselect and retake unwired until their concrete UI journeys are approved', async () => {
    const wrapper = await renderTask()

    for (const action of ['重新选择区域', '重新拍摄']) {
      buttonByName(resolver(wrapper), action)!.click()
      await nextTick()
    }

    expect(h.sourceAction).not.toHaveBeenCalled()
    expect(wrapper.emitted('sourceIssueIntent')).toBeUndefined()
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('等待处理题源问题')
  })

  it('PROG-026 applies only the post-commit server snapshot and uses its structure/input revision for the next action', async () => {
    const first = deferred<ReturnType<typeof sourceActionResponse>>()
    const second = deferred<ReturnType<typeof sourceActionResponse>>()
    h.sourceAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = await renderTask()

    ;(await openSkipConfirmation(wrapper)).click()
    await nextTick()
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).not.toContain('已跳过 · 未判断对错')

    first.resolve(
      sourceActionResponse({
        structureVersion: 4,
        inputRevision: 2,
        snapshotRevision: 11,
        coverage: {
          total: 1,
          published: 0,
          skipped: 1,
          awaiting: 0,
          failed: 0,
          status: 'complete',
          projection_revision: 11,
        },
      }),
    )
    await flushPromises()
    await flushPromises()

    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('已跳过 · 未判断对错')
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('一. 1')
    const resume = buttonByName(resolver(wrapper), '恢复处理')
    expect(resume).not.toBeNull()
    resume!.click()
    await nextTick()

    expect(h.sourceAction).toHaveBeenCalledTimes(2)
    expect(h.sourceAction.mock.calls[1]?.[2]).toEqual({
      action: 'resume',
      structure_version: 4,
      expected_input_revision: 2,
      payload: {},
    })

    second.resolve(
      sourceActionResponse({
        action: 'resume',
        structureVersion: 4,
        inputRevision: 3,
        snapshotRevision: 12,
      }),
    )
    await flushPromises()
    await flushPromises()

    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('等待处理题源问题')
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('一. 1')
    expect(buttonByName(resolver(wrapper), '纠正识别')).not.toBeNull()
  })

  it('PROG-026 applies the correct_text post-commit processing snapshot without local optimism', async () => {
    const committed = deferred<ReturnType<typeof sourceActionResponse>>()
    h.sourceAction.mockReturnValueOnce(committed.promise)
    const wrapper = await renderTask()

    buttonByName(resolver(wrapper), '纠正识别')!.click()
    await nextTick()
    await wrapper.get('textarea').setValue('8 的四分之一是多少？')
    buttonByName(resolver(wrapper), '保存并重新处理')!.click()
    await nextTick()

    expect(h.sourceAction).toHaveBeenCalledWith(
      'dispatch-progressive-wave-3',
      'problem-1',
      {
        action: 'correct_text',
        structure_version: 4,
        expected_input_revision: 2,
        payload: { question_canonical_markdown: '8 的四分之一是多少？' },
      },
      expect.any(String),
      expect.anything(),
    )
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('等待处理题源问题')

    committed.resolve(
      sourceActionResponse({
        action: 'correct_text',
        structureVersion: 4,
        inputRevision: 3,
        snapshotRevision: 12,
      }),
    )
    await flushPromises()
    await flushPromises()

    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('处理中')
    expect(wrapper.get('[data-problem-id="problem-1"]').text()).toContain('一. 1')
    expect(wrapper.find('[data-source-issue-resolver]').exists()).toBe(false)
  })
})
