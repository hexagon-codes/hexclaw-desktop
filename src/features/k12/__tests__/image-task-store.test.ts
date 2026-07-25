import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { K12_IMAGE_TASK_BINDINGS_KEY } from '../image-task-binding'

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  getResult: vi.fn(),
  confirm: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12DeleteMistake: vi.fn(),
  k12TutoringTips: vi.fn(),
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
  k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

import { useK12Store } from '../store'

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-1',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage: 'awaiting_confirmation',
        confirmation_state: 'pending',
        anchor_state: 'located',
        recognition: {
          subject: '数学',
          questions: [
            {
              problem_id: 'p-1',
              question: '4.5×2=',
              knowledge_points: ['小数乘法'],
              answer_state: 'present',
              student_answer: '9',
              confirmation_required: true,
              confirmation_reasons: ['decimal_point'],
            },
          ],
        },
      },
      progress: { operation: 'homework', state: 'awaiting_confirmation' },
      version: 3,
      created_at: 1,
      updated_at: 2,
      ...overrides,
    },
  }
}

describe('K12 store ImageTaskDispatch adoption', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    Object.values(h).forEach((spy) => spy.mockReset())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uploads the immutable image and creates one facade dispatch with the frozen route', async () => {
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/sha.png', size: 3 })
    h.create.mockResolvedValue({ created: true, ...dispatch() })

    const result = await useK12Store().dispatchImageTask({
      agent: 'mingming',
      dataUrl: 'data:image/png;base64,QUJD',
      sourceSession: 'session-1',
      sourceRef: 'message-1',
      messageIntent: '请批改',
      route: {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        capability: 'vision',
      },
    })

    expect(result).toMatchObject({
      dispatchId: 'dispatch-1',
      dispatchVersion: 3,
      taskIntent: 'completed_homework',
      stage: 'awaiting_confirmation',
      subject: '数学',
      anchorState: 'located',
    })
    expect(result.questions).toHaveLength(1)
    expect(h.upload).toHaveBeenCalledWith(
      'mingming',
      expect.objectContaining({ type: 'image/png' }),
      undefined,
      undefined,
    )
    expect(h.create).toHaveBeenCalledWith(
      {
        agent: 'mingming',
        source_session: 'session-1',
        source_kind: 'desktop',
        source_ref: 'message-1',
        source_asset_refs: ['asset://mingming/sha.png'],
        message_intent: '请批改',
        attempt_generation: 1,
        route_request: {
          provider: 'hexclaw-gpt',
          model: 'gpt-5.6-sol',
          selection_source: 'explicit',
        },
      },
      undefined,
    )
    expect(JSON.parse(localStorage.getItem(K12_IMAGE_TASK_BINDINGS_KEY) ?? '{}')).toMatchObject({
      bindings: {
        'session-1': {
          agent_id: 'mingming',
          dispatch_id: 'dispatch-1',
        },
      },
    })
  })

  it('reads a blank worksheet only from the discriminated facade result', async () => {
    h.get.mockResolvedValue(
      dispatch({
        task_intent: 'blank_worksheet',
        target_projection: {
          kind: 'homework',
          stage: 'completed',
          confirmation_state: 'confirmed',
          anchor_state: 'located',
        },
      }),
    )
    h.getResult.mockResolvedValue({
      dispatch_id: 'dispatch-1',
      task_intent: 'blank_worksheet',
      status: 'routed',
      result: {
        kind: 'blank_worksheet',
        payload: {
          mode: 'solve',
          task_intent: 'blank_worksheet',
          result_surface: 'parent_teaching_guide',
          items: [],
          markdown: '# 家长讲题指南',
        },
      },
    })

    const outcome = await useK12Store().completeImageTask('mingming', 'dispatch-1', {
      sourceSession: 'session-1',
    })

    expect(outcome).toEqual({
      stage: 'completed',
      taskIntent: 'blank_worksheet',
      result: expect.objectContaining({ result_surface: 'parent_teaching_guide' }),
    })
    expect(h.getResult).toHaveBeenCalledWith('mingming', 'dispatch-1', undefined)
  })

  it('freezes only the confirmed writing OCR conflicts through the creative facade', async () => {
    h.confirm.mockResolvedValue(
      dispatch({
        task_intent: 'writing',
        version: 4,
        target: { type: 'creative_work_intake', id: 'intake-1' },
        target_projection: {
          kind: 'creative',
          intake_id: 'intake-1',
          work_type: 'writing',
          status: 'promoted',
          canonical_version: 7,
          canonical_content: '我的好爸爸',
          conflicts: [],
        },
        progress: { operation: 'promotion', state: 'feedback_pending' },
      }),
    )

    await expect(
      useK12Store().confirmImageTask('mingming', 'dispatch-1', 3, {
        creative: {
          action: 'freeze_ocr',
          canonical_version: 7,
          canonical_content: '我的好爸爸',
          segment_corrections: [
            {
              segment_id: 'segment-1',
              canonical_text: '好爸爸',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      dispatchId: 'dispatch-1',
      dispatchVersion: 4,
      taskIntent: 'writing',
      stage: 'feedback_pending',
    })
    expect(h.confirm).toHaveBeenCalledWith(
      'dispatch-1',
      {
        agent: 'mingming',
        version: 3,
        creative: {
          action: 'freeze_ocr',
          canonical_version: 7,
          canonical_content: '我的好爸爸',
          segment_corrections: [
            {
              segment_id: 'segment-1',
              canonical_text: '好爸爸',
            },
          ],
        },
      },
      undefined,
    )
  })

  it('retries and cancels only the same owner-scoped dispatch version', async () => {
    h.retry.mockResolvedValue(dispatch({ version: 4 }))
    h.cancel.mockResolvedValue(
      dispatch({
        status: 'cancelled',
        version: 5,
        target_projection: {
          kind: 'homework',
          stage: 'cancelled',
          confirmation_state: 'pending',
          anchor_state: 'located',
        },
      }),
    )
    const store = useK12Store()

    await expect(store.retryImageTask('mingming', 'dispatch-1', 3)).resolves.toMatchObject({
      dispatchId: 'dispatch-1',
      dispatchVersion: 4,
    })
    await expect(store.cancelImageTask('mingming', 'dispatch-1', 4)).resolves.toMatchObject({
      dispatchId: 'dispatch-1',
      dispatchVersion: 5,
      stage: 'cancelled',
    })
    expect(h.retry).toHaveBeenCalledWith('dispatch-1', { agent: 'mingming', version: 3 }, undefined)
    expect(h.cancel).toHaveBeenCalledWith(
      'dispatch-1',
      { agent: 'mingming', version: 4 },
      undefined,
    )
  })

  it('auto-advances clear homework and stops only for the smallest real OCR conflict', async () => {
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/sha.png', size: 3 })
    const clearAwaiting = dispatch({
      target_projection: {
        kind: 'homework',
        stage: 'awaiting_confirmation',
        confirmation_state: 'pending',
        anchor_state: 'located',
        recognition: {
          subject: '数学',
          questions: [
            {
              problem_id: 'p-clear',
              question: '1+1=2',
              knowledge_points: ['加法'],
              answer_state: 'present',
              student_answer: '2',
              confirmation_required: false,
            },
          ],
        },
      },
    })
    h.create.mockResolvedValue({ created: true, ...clearAwaiting })
    h.get.mockResolvedValue(
      dispatch({
        target_projection: {
          kind: 'homework',
          stage: 'completed',
          confirmation_state: 'confirmed',
          anchor_state: 'located',
        },
      }),
    )

    await expect(
      useK12Store().dispatchImageTask({
        agent: 'mingming',
        dataUrl: 'data:image/png;base64,QUJD',
        sourceSession: 'session-clear',
        sourceRef: 'message-clear',
      }),
    ).resolves.toMatchObject({ stage: 'completed' })
    expect(h.get).toHaveBeenCalledTimes(1)

    h.get.mockClear()
    h.create.mockResolvedValue({
      created: true,
      ...dispatch({
        target_projection: {
          kind: 'homework',
          stage: 'awaiting_confirmation',
          confirmation_state: 'pending',
          anchor_state: 'located',
          recognition: {
            subject: '数学',
            questions: [
              {
                problem_id: 'p-risk',
                question: '1.2+3.4=?',
                knowledge_points: ['小数加法'],
                answer_state: 'present',
                student_answer: '4.6',
                confirmation_required: true,
                confirmation_reasons: ['decimal_point'],
              },
            ],
          },
        },
      }),
    })
    await expect(
      useK12Store().dispatchImageTask({
        agent: 'mingming',
        dataUrl: 'data:image/png;base64,QUJD',
        sourceSession: 'session-risk',
        sourceRef: 'message-risk',
      }),
    ).resolves.toMatchObject({ stage: 'awaiting_confirmation' })
    expect(h.get).not.toHaveBeenCalled()
  })

  it('auto-advances clear writing OCR and stops only when the intake exposes conflicts', async () => {
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/sha.png', size: 3 })
    const writingDispatch = (
      status: 'awaiting_confirmation' | 'promoted',
      conflicts: Array<Record<string, unknown>>,
      progressState: string,
    ) =>
      dispatch({
        task_intent: 'writing',
        target: { type: 'creative_work_intake', id: 'intake-1' },
        target_projection: {
          kind: 'creative',
          intake_id: 'intake-1',
          work_type: 'writing',
          status,
          canonical_version: 1,
          canonical_content: '我的好爸爸',
          conflicts,
        },
        progress: {
          operation: status === 'promoted' ? 'promotion' : 'writing_ocr',
          state: progressState,
        },
      })

    h.create.mockResolvedValue({
      created: true,
      ...writingDispatch('awaiting_confirmation', [], 'awaiting_confirmation'),
    })
    h.get.mockResolvedValue(writingDispatch('promoted', [], 'feedback_ready'))

    await expect(
      useK12Store().dispatchImageTask({
        agent: 'mingming',
        dataUrl: 'data:image/png;base64,QUJD',
        sourceSession: 'session-writing-clear',
        sourceRef: 'message-writing-clear',
      }),
    ).resolves.toMatchObject({ taskIntent: 'writing', stage: 'feedback_ready' })
    expect(h.get).toHaveBeenCalledTimes(1)

    h.get.mockClear()
    h.create.mockResolvedValue({
      created: true,
      ...writingDispatch(
        'awaiting_confirmation',
        [
          {
            segment_id: 'segment-1',
            raw_text: '爸色',
            canonical_text: '爸色',
            reason: 'low_confidence',
          },
        ],
        'awaiting_confirmation',
      ),
    })
    await expect(
      useK12Store().dispatchImageTask({
        agent: 'mingming',
        dataUrl: 'data:image/png;base64,QUJD',
        sourceSession: 'session-writing-risk',
        sourceRef: 'message-writing-risk',
      }),
    ).resolves.toMatchObject({ taskIntent: 'writing', stage: 'awaiting_confirmation' })
    expect(h.get).not.toHaveBeenCalled()
  })

  it('keeps polling the same promoted creative dispatch until durable feedback is ready', async () => {
    vi.useFakeTimers()
    const creativeDispatch = (state: string) =>
      dispatch({
        task_intent: 'artwork',
        target: { type: 'creative_work_intake', id: 'intake-1' },
        target_projection: {
          kind: 'creative',
          intake_id: 'intake-1',
          work_type: 'art',
          status: 'promoted',
          work: { work_id: 'work-1', display_name: '美术作品' },
        },
        progress: { operation: 'promotion', state },
      })
    h.get
      .mockResolvedValueOnce(creativeDispatch('feedback_pending'))
      .mockResolvedValueOnce(creativeDispatch('recovering'))
      .mockResolvedValueOnce(creativeDispatch('feedback_ready'))
    h.getResult.mockResolvedValue({
      dispatch_id: 'dispatch-1',
      task_intent: 'artwork',
      status: 'routed',
      result: {
        kind: 'artwork',
        payload: {
          intake: { intake_id: 'intake-1', status: 'promoted' },
          work: { work_id: 'work-1', display_name: '美术作品' },
          feedback: {
            structured_feedback: {
              feedback_id: 'feedback-1',
              version_id: 'version-1',
              feedback_type: 'art',
              evidence_refs: ['asset-ref:sha256:abc'],
              observations: [{ dimension: '构图', evidence: '主体位于画面中央。' }],
              source_snapshot: {
                source: 'ai',
                method_ref: 'art-feedback@1.0.0',
                capability: 'art_feedback',
              },
              limitations: '只依据当前照片中可见的画面。',
              suggestions: ['补充画面层次。'],
              projection_markdown: '## 观察与依据',
            },
            projection_markdown: '## 观察与依据',
          },
        },
      },
    })
    const onStatus = vi.fn()

    const completion = useK12Store().completeImageTask(
      'mingming',
      'dispatch-1',
      { sourceSession: 'session-creative' },
      undefined,
      onStatus,
    )
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.getResult).not.toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        progress: { operation: 'promotion', state: 'recovering' },
      }),
    )

    await vi.advanceTimersByTimeAsync(2_500)
    await expect(completion).resolves.toMatchObject({
      stage: 'promoted',
      taskIntent: 'artwork',
      result: {
        feedback: {
          projection_markdown: '## 观察与依据',
        },
      },
    })
    expect(h.get).toHaveBeenCalledTimes(3)
    expect(h.getResult).toHaveBeenCalledTimes(1)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.retry).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it('projects the public creative recovering state instead of the promoted intake state', async () => {
    h.retry.mockResolvedValue(
      dispatch({
        task_intent: 'artwork',
        target: { type: 'creative_work_intake', id: 'intake-1' },
        target_projection: {
          kind: 'creative',
          intake_id: 'intake-1',
          work_type: 'art',
          status: 'promoted',
          work: { work_id: 'work-1', display_name: '美术作品' },
        },
        progress: { operation: 'promotion', state: 'recovering' },
      }),
    )

    await expect(useK12Store().retryImageTask('mingming', 'dispatch-1', 3)).resolves.toMatchObject({
      taskIntent: 'artwork',
      stage: 'recovering',
    })
  })
})
