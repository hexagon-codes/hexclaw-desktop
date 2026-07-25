import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
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

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function homeworkDispatch(
  stage: string,
  confirmationState: 'pending' | 'confirmed',
  questions: Array<Record<string, unknown>>,
) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-homework',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage,
        confirmation_state: confirmationState,
        anchor_state: 'located',
        recognition: { subject: '数学', questions },
      },
      progress: { operation: 'homework', state: stage },
      version: 2,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function creativeDispatch(
  intent: 'writing' | 'artwork',
  feedbackState:
    | 'feedback_pending'
    | 'feedback_ready'
    | 'feedback_failed'
    | 'recovering' = 'feedback_ready',
) {
  const writing = intent === 'writing'
  return {
    dispatch: {
      dispatch_id: `dispatch-${intent}`,
      task_intent: intent,
      status: 'routed',
      intent_evidence: [writing ? 'long_form_handwriting' : 'artwork_visual_evidence'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'creative_work_intake', id: 'intake-1' },
      target_projection: {
        kind: 'creative',
        intake_id: 'intake-1',
        work_type: writing ? 'writing' : 'art',
        status: 'promoted',
        work: { work_id: 'work-1', display_name: writing ? '语文写作' : '美术作品' },
      },
      progress: { operation: 'promotion', state: feedbackState },
      version: 2,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function writingConflictDispatch() {
  return {
    dispatch: {
      dispatch_id: 'dispatch-writing',
      task_intent: 'writing',
      status: 'routed',
      intent_evidence: ['long_form_handwriting'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'creative_work_intake', id: 'intake-1' },
      target_projection: {
        kind: 'creative',
        intake_id: 'intake-1',
        work_type: 'writing',
        status: 'awaiting_confirmation',
        canonical_version: 7,
        canonical_content: '我的好爸色',
        conflicts: [
          {
            segment_id: 'segment-1',
            raw_text: '爸色',
            canonical_text: '爸色',
            reason: 'low_confidence',
          },
        ],
      },
      progress: { operation: 'writing_ocr', state: 'awaiting_confirmation' },
      version: 3,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function mountPanel() {
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      grade: '五年级下',
      sessionId: 'session-1',
      requestId: 'message-1',
      initialImage: 'data:image/png;base64,QUJD',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('K12 ImageTask intent-specific TaskShell projection', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('completed_homework uses the approved shell copy and confirms only actual conflict facts', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...homeworkDispatch('awaiting_confirmation', 'pending', [
        {
          problem_id: 'p-clear',
          question: '1+1=2',
          knowledge_points: ['加法'],
          answer_state: 'present',
          student_answer: '2',
          confirmation_required: false,
        },
        {
          problem_id: 'p-risk',
          question: '1.2+3.4=4.6',
          knowledge_points: ['小数加法'],
          answer_state: 'present',
          student_answer: '4.6',
          confirmation_required: true,
          confirmation_reasons: ['decimal_point'],
        },
      ]),
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('[data-testid="recognize-pipeline"]').text()).toContain('已作答作业')
    expect(wrapper.text()).not.toContain('批改准备')
    expect(wrapper.findAll('[data-testid^="rq-risk-"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid^="rq-confirm-"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(true)
  })

  it('clear completed_homework reaches its result without any confirmation control', async () => {
    const completedQuestion = {
      problem_id: 'p-complete',
      question: '4÷0.5=8',
      knowledge_points: ['小数除法'],
      answer_state: 'present',
      student_answer: '8',
      confirmation_required: false,
    }
    const completed = homeworkDispatch('completed', 'confirmed', [completedQuestion])
    h.create.mockResolvedValue({ created: true, ...completed })
    h.get.mockResolvedValue(completed)
    h.getResult.mockResolvedValue({
      dispatch_id: 'dispatch-homework',
      task_intent: 'completed_homework',
      status: 'routed',
      result: {
        kind: 'completed_homework',
        payload: {
          mode: 'grade',
          task_intent: 'completed_homework',
          result_surface: 'annotated_homework',
          items: [
            {
              question: completedQuestion,
              status: 'correct',
              grade: {
                solution: '8',
                verdict: 'agree',
                evidence_type: 'numeric_exec',
                badge: 'verified-strong',
                out_of_scope: false,
                record_created: false,
              },
            },
          ],
          markdown: '# 批改完成',
        },
      },
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-answer-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-grade-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-solve-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-solve-all"]').exists()).toBe(false)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('writing/artwork never enter homework rows, pipeline, or homework empty copy', async () => {
    for (const intent of ['writing', 'artwork'] as const) {
      const projectionMarkdown =
        intent === 'writing'
          ? '## 观察与依据\n\n- 文章围绕爸爸展开。'
          : '## 观察与依据\n\n- 主体位于画面中央。'
      const promoted = creativeDispatch(intent)
      h.create.mockResolvedValue({ created: true, ...promoted })
      h.get.mockResolvedValue(promoted)
      h.getResult.mockResolvedValue({
        dispatch_id: `dispatch-${intent}`,
        task_intent: intent,
        status: 'routed',
        result: {
          kind: intent,
          payload: {
            intake: { intake_id: 'intake-1', status: 'promoted' },
            work: {
              work_id: 'work-1',
              display_name: intent === 'writing' ? '语文写作' : '美术作品',
            },
            feedback: {
              structured_feedback: {
                feedback_id: 'feedback-1',
                version_id: 'version-1',
                feedback_type: intent === 'writing' ? 'writing' : 'art',
                evidence_refs: ['asset-ref:sha256:abc'],
                observations: [
                  {
                    dimension: intent === 'writing' ? '主题' : '构图',
                    evidence: intent === 'writing' ? '文章围绕爸爸展开。' : '主体位于画面中央。',
                  },
                ],
                source_snapshot: {
                  source: 'ai',
                  method_ref: `${intent}-feedback@1.0.0`,
                  capability: `${intent}_feedback`,
                },
                limitations: '只依据当前图片中可见内容。',
                suggestions: ['保留原作并补充一个具体细节。'],
                projection_markdown: projectionMarkdown,
              },
              projection_markdown: projectionMarkdown,
            },
          },
        },
      })

      const wrapper = mountPanel()
      await flushPromises()

      expect(wrapper.find('[data-testid="recognize-pipeline"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(0)
      expect(wrapper.find('.rec-panel__empty').exists()).toBe(false)
      expect(wrapper.find('.rec-panel__err').exists()).toBe(false)
      expect(wrapper.get(`[data-testid="${intent}-result-surface"]`).attributes()).toMatchObject({
        'data-task-intent': intent,
        'data-result-surface': intent === 'writing' ? 'writing-feedback' : 'art-feedback',
        'data-intake-status': 'promoted',
        'data-work-id': 'work-1',
      })
      const feedback = wrapper.get(`[data-testid="${intent}-result-feedback"]`)
      expect(feedback.text()).toContain(
        intent === 'writing' ? '文章围绕爸爸展开。' : '主体位于画面中央。',
      )
      expect(feedback.text()).not.toContain('##')
      wrapper.unmount()
      h.create.mockReset()
      h.get.mockReset()
      h.getResult.mockReset()
    }
  })

  it('keeps writing OCR conflicts in the same TaskShell and continues automatically after correction', async () => {
    h.create.mockResolvedValue({ created: true, ...writingConflictDispatch() })
    h.confirm.mockResolvedValue({
      dispatch: {
        ...creativeDispatch('writing', 'feedback_pending').dispatch,
        version: 4,
      },
    })
    h.get.mockResolvedValue(creativeDispatch('writing', 'feedback_ready'))
    h.getResult.mockResolvedValue({
      dispatch_id: 'dispatch-writing',
      task_intent: 'writing',
      status: 'routed',
      result: {
        kind: 'writing',
        payload: {
          intake: { intake_id: 'intake-1', status: 'promoted' },
          work: { work_id: 'work-1', display_name: '语文写作' },
          feedback: {
            structured_feedback: {
              feedback_id: 'feedback-1',
              version_id: 'version-1',
              feedback_type: 'writing',
              evidence_refs: ['asset-ref:sha256:abc'],
              observations: [{ dimension: '主题', evidence: '文章围绕爸爸展开。' }],
              source_snapshot: {
                source: 'ai',
                method_ref: 'writing-feedback@1.0.0',
                capability: 'writing_feedback',
              },
              limitations: '只依据当前图片中可见内容。',
              suggestions: ['补充一个具体细节。'],
              projection_markdown: '## 观察与依据\n\n- 文章围绕爸爸展开。',
            },
            projection_markdown: '## 观察与依据\n\n- 文章围绕爸爸展开。',
          },
        },
      },
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('.rec-panel__title').text()).toBe('语文写作')
    expect(wrapper.find('[data-testid="recognize-pipeline"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="creative-conflict-item"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="creative-conflict-item"]').text()).toContain('爸色')
    expect(wrapper.find('[data-testid="creative-work-form"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="creative-confirm-all"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="creative-conflict-edit"]').trigger('click')
    await wrapper.get('[data-testid="creative-conflict-input"]').setValue('爸爸')
    await wrapper.get('[data-testid="creative-conflict-confirm"]').setValue(true)
    await wrapper.get('[data-testid="creative-confirm-all"]').trigger('click')
    await flushPromises()

    expect(h.confirm).toHaveBeenCalledWith(
      'dispatch-writing',
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
              canonical_text: '爸爸',
            },
          ],
        },
      },
      expect.any(AbortSignal),
    )
    expect(h.get).toHaveBeenCalledWith('mingming', 'dispatch-writing', expect.any(AbortSignal))
    expect(wrapper.get('[data-testid="writing-result-feedback"]').text()).toContain(
      '文章围绕爸爸展开。',
    )
  })

  it('creative recovering uses the public transient recovery projection', async () => {
    vi.useFakeTimers()
    h.create.mockResolvedValue({
      created: true,
      ...creativeDispatch('artwork', 'feedback_pending'),
    })
    h.get
      .mockResolvedValueOnce(creativeDispatch('artwork', 'recovering'))
      .mockResolvedValueOnce(creativeDispatch('artwork', 'feedback_ready'))

    const wrapper = mountPanel()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(wrapper.get('[data-testid="recognize-recovering"]').text()).toContain('正在恢复批改结果')
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.retry).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
  })
})
