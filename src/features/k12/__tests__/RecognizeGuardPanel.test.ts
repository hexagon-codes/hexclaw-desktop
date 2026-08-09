import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
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
  grade: vi.fn(),
  solve: vi.fn(),
  tutoringTips: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12UploadAsset: (...args: unknown[]) => h.upload(...args),
  k12CreateImageTask: (...args: unknown[]) => h.create(...args),
  k12GetImageTask: (...args: unknown[]) => h.get(...args),
  k12GetImageTaskResult: (...args: unknown[]) => h.getResult(...args),
  k12ConfirmImageTask: (...args: unknown[]) => h.confirm(...args),
  k12RetryImageTask: (...args: unknown[]) => h.retry(...args),
  k12CancelImageTask: (...args: unknown[]) => h.cancel(...args),
  // These exports remain mocked only to prove that the image-task shell never
  // falls back to the retired Desktop-side per-question execution path.
  k12Grade: (...args: unknown[]) => h.grade(...args),
  k12Solve: (...args: unknown[]) => h.solve(...args),
  k12TutoringTips: (...args: unknown[]) => h.tutoringTips(...args),
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12DeleteMistake: vi.fn(),
  k12RecordMistake: vi.fn(),
  k12AddGrounding: vi.fn(),
  k12QueryDeliveryReceipt: vi.fn(),
  k12RetryDeliveryReceipt: vi.fn(),
  k12SendTutoringTips: vi.fn(),
  k12InsightReport: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

const clearQuestion = {
  problem_id: 'problem-clear',
  question: '4÷0.5=8',
  canonical_markdown: '4\\div 0.5=8',
  knowledge_points: ['小数除法'],
  answer_state: 'present',
  student_answer: '8',
  answer_canonical_markdown: '8',
  confirmation_required: false,
  confirmation_reasons: [],
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.06 },
}

const riskQuestion = {
  problem_id: 'problem-risk',
  question: '10×0.01=1',
  canonical_markdown: '10\\times 0.01=1',
  knowledge_points: ['小数乘法'],
  answer_state: 'present',
  student_answer: '1',
  answer_canonical_markdown: '1',
  confirmation_required: true,
  confirmation_reasons: ['decimal_point'],
  bbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.06 },
}

const parentGuide = {
  answer: '0.1',
  full_solution_steps: ['先理解 0.01 表示百分之一。', '10 个百分之一是 0.1。'],
  grade_level_method: '用五年级小数乘法和位值表来讲。',
  likely_mistakes: ['把乘以 0.01 看成乘以 0.1。'],
  parent_teaching_sequence: ['先问 0.01 的意义。', '再让孩子用位值表重算。'],
  follow_up_questions: ['100×0.01 等于多少？'],
  checking_method: '用 0.1÷0.01=10 反向验算。',
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function homeworkStatus(
  stage: string,
  {
    questions = [] as Array<Record<string, unknown>>,
    confirmationState = 'pending',
    dispatchStatus = 'routed',
    taskIntent = 'completed_homework',
    version = 3,
  }: {
    questions?: Array<Record<string, unknown>>
    confirmationState?: 'pending' | 'confirmed'
    dispatchStatus?: 'routing' | 'awaiting_confirmation' | 'routed' | 'failed' | 'cancelled'
    taskIntent?: 'completed_homework' | 'blank_worksheet'
    version?: number
  } = {},
) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-1',
      task_intent: taskIntent,
      status: dispatchStatus,
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage,
        confirmation_state: confirmationState,
        anchor_state: 'located',
        ...(questions.length ? { recognition: { subject: '数学', questions } } : {}),
      },
      progress: { operation: 'homework', state: stage },
      version,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function completedResult() {
  return {
    dispatch_id: 'dispatch-1',
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
            question: clearQuestion,
            status: 'correct',
            result_kind: 'assessment',
            grade: {
              solution: '8',
              verdict: 'agree',
              evidence_type: 'numeric_exec',
              badge: 'verified-strong',
              out_of_scope: false,
              record_created: false,
            },
          },
          {
            question: riskQuestion,
            status: 'wrong',
            result_kind: 'assessment',
            grade: {
              solution: '0.1',
              verdict: 'disagree',
              evidence_type: 'numeric_exec',
              badge: 'disagree',
              wrong_step: '小数位数判断错误。',
              error_cause: '把百分之一看成十分之一。',
              out_of_scope: false,
              record_created: true,
              record_id: 'mistake-1',
            },
            parent_guide: parentGuide,
          },
        ],
        markdown: '# 批改完成',
        image_warning: '',
        annotated_image: {
          mime: 'image/png',
          data_base64: 'QU5OT1RBVEVE',
          digest: 'sha256:annotated',
        },
      },
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
      initialImage: 'data:image/png;base64,T1JJR0lOQUw=',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('RecognizeGuardPanel · ImageTaskDispatch 自动处理契约', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/homework.png', size: 3 })
    h.tutoringTips.mockResolvedValue({ knowledge_points: [], sections: [] })
  })

  it('先固化 Asset，再只通过公开 facade 轮询到最小冲突停点', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...homeworkStatus('queued', { dispatchStatus: 'routing', version: 1 }),
    })
    h.get.mockResolvedValue(
      homeworkStatus('awaiting_confirmation', {
        questions: [clearQuestion, riskQuestion],
        dispatchStatus: 'routed',
        version: 2,
      }),
    )

    const wrapper = mountPanel()
    await flushPromises()

    expect(h.upload).toHaveBeenCalledWith(
      'mingming',
      expect.any(File),
      undefined,
      expect.any(AbortSignal),
    )
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'mingming',
        source_session: 'session-1',
        source_kind: 'desktop',
        source_ref: 'message-1',
        source_asset_refs: ['asset://mingming/homework.png'],
        attempt_generation: 1,
        route_request: { selection_source: 'auto' },
      }),
      expect.any(AbortSignal),
    )
    expect(h.get).toHaveBeenCalledWith('mingming', 'dispatch-1', expect.any(AbortSignal))
    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid^="rq-risk-"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid^="rq-confirm-"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="recognize-pipeline"]').text()).toContain(
      '清晰内容自动处理 · 仅核对 1 处不确定项',
    )
  })

  it('空白卷在持久题目确认停点复用既有识题行', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...homeworkStatus('awaiting_confirmation', {
        questions: [clearQuestion, riskQuestion],
        dispatchStatus: 'routed',
        taskIntent: 'blank_worksheet',
        version: 2,
      }),
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid^="rq-confirm-"]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('还没识题')
  })

  it('不再暴露或调用 Desktop 逐题批改、逐题求解和二次整卷动作', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...homeworkStatus('awaiting_confirmation', {
        questions: [clearQuestion, riskQuestion],
        dispatchStatus: 'routed',
      }),
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid^="rq-answer-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-grade-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-solve-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-solve-all"]').exists()).toBe(false)
    expect(h.grade).not.toHaveBeenCalled()
    expect(h.solve).not.toHaveBeenCalled()
  })

  it('只提交风险事实，确认后轮询同一 dispatch 并自动展示批注结果', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...homeworkStatus('awaiting_confirmation', {
        questions: [clearQuestion, riskQuestion],
        dispatchStatus: 'routed',
        version: 3,
      }),
    })
    h.confirm.mockResolvedValue(
      homeworkStatus('assessing', {
        questions: [clearQuestion, riskQuestion],
        confirmationState: 'confirmed',
        version: 4,
      }),
    )
    h.get.mockResolvedValue(
      homeworkStatus('completed', {
        questions: [clearQuestion, riskQuestion],
        confirmationState: 'confirmed',
        version: 5,
      }),
    )
    h.getResult.mockResolvedValue(completedResult())

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="rq-confirm-1"]').setValue(true)
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    expect(h.confirm).toHaveBeenCalledWith(
      'dispatch-1',
      {
        agent: 'mingming',
        version: 3,
        homework: {
          subject: '数学',
          grade: '五年级下',
          question_corrections: [
            expect.objectContaining({
              index: 1,
              problem_id: 'problem-risk',
              confirmed: true,
              canonical_markdown: '10\\times 0.01=1',
              answer_canonical_markdown: '1',
            }),
          ],
        },
      },
      expect.any(AbortSignal),
    )
    expect(h.get).toHaveBeenCalledWith('mingming', 'dispatch-1', expect.any(AbortSignal))
    expect(h.getResult).toHaveBeenCalledWith('mingming', 'dispatch-1', expect.any(AbortSignal))
    expect(wrapper.get('[data-testid="overlay-image"]').attributes('src')).toBe(
      'data:image/png;base64,QU5OT1RBVEVE',
    )
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(h.grade).not.toHaveBeenCalled()
    expect(h.solve).not.toHaveBeenCalled()
  })

  it('没有冲突的已完成作业直接读终态，零人工确认', async () => {
    const completed = homeworkStatus('completed', {
      questions: [clearQuestion],
      confirmationState: 'confirmed',
      version: 5,
    })
    const result = completedResult()
    result.result.payload.items = [result.result.payload.items[0]!]
    h.create.mockResolvedValue({ created: true, ...completed })
    h.get.mockResolvedValue(completed)
    h.getResult.mockResolvedValue(result)

    const wrapper = mountPanel()
    await flushPromises()

    expect(h.confirm).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-confirm-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
  })

  it('确认冲突返回 409 时留在原任务，不绕过 facade 生成结果', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...homeworkStatus('awaiting_confirmation', {
        questions: [riskQuestion],
        dispatchStatus: 'routed',
        version: 3,
      }),
    })
    h.confirm.mockRejectedValue(new Error('409 version conflict'))

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="rq-confirm-0"]').setValue(true)
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.getResult).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('409 version conflict')
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(h.grade).not.toHaveBeenCalled()
    expect(h.solve).not.toHaveBeenCalled()
  })
})
