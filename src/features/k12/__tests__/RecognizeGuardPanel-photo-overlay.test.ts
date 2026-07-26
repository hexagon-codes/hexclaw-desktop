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

const correctQuestion = {
  problem_id: 'p-correct',
  source_number_path: ['一', '1'],
  display_label: '一. 1',
  question: '4÷0.5=8',
  canonical_markdown: '4\\div 0.5=8',
  knowledge_points: ['小数除法'],
  answer_state: 'present',
  student_answer: '8',
  answer_canonical_markdown: '8',
  confirmation_required: false,
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.06 },
}

const wrongQuestion = {
  problem_id: 'p-wrong',
  source_number_path: ['一', '2'],
  display_label: '一. 2',
  question: '10×0.01=1',
  canonical_markdown: '10\\times 0.01=1',
  knowledge_points: ['小数乘法'],
  answer_state: 'present',
  student_answer: '1',
  answer_canonical_markdown: '1',
  confirmation_required: false,
  bbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.06 },
}

function guide(answer = '0.1') {
  return {
    answer,
    full_solution_steps: ['先看题目中的数量关系。', '按本年级方法分步计算。'],
    grade_level_method: '用五年级已经学过的位值和运算规则来讲。',
    likely_mistakes: ['看错小数点位置。'],
    parent_teaching_sequence: ['先让孩子复述题意。', '再遮住答案独立重算。'],
    follow_up_questions: ['换一个数还能怎样计算？'],
    checking_method: '用逆运算检查结果。',
  }
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function completedDispatch(
  taskIntent: 'completed_homework' | 'blank_worksheet',
  questions: Array<Record<string, unknown>>,
) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-result',
      task_intent: taskIntent,
      status: 'routed',
      intent_evidence: [
        taskIntent === 'completed_homework' ? 'answer_regions_present' : 'answer_regions_blank',
      ],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage: 'completed',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        recognition: { subject: '数学', questions },
      },
      progress: { operation: 'homework', state: 'completed' },
      version: 4,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function grade(
  verdict: 'agree' | 'disagree' | 'out_of_scope',
  solution: string,
  extra: Record<string, unknown> = {},
) {
  return {
    solution,
    verdict,
    evidence_type: 'numeric_exec',
    badge:
      verdict === 'agree'
        ? 'verified-strong'
        : verdict === 'disagree'
          ? 'disagree'
          : 'out-of-scope',
    out_of_scope: verdict === 'out_of_scope',
    record_created: false,
    ...extra,
  }
}

function completedHomeworkResult({
  annotated = true,
  items,
}: {
  annotated?: boolean
  items: Array<Record<string, unknown>>
}) {
  return {
    dispatch_id: 'dispatch-result',
    task_intent: 'completed_homework',
    status: 'routed',
    result: {
      kind: 'completed_homework',
      payload: {
        mode: 'grade',
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        items,
        markdown: '# 批改完成',
        image_warning: '',
        ...(annotated
          ? {
              annotated_image: {
                mime: 'image/png',
                data_base64: 'QU5OT1RBVEVE',
                digest: 'sha256:annotated',
              },
            }
          : {}),
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

function installTerminal(
  dispatch: ReturnType<typeof completedDispatch>,
  result: Record<string, unknown>,
) {
  h.create.mockResolvedValue({ created: true, ...dispatch })
  h.get.mockResolvedValue(dispatch)
  h.getResult.mockResolvedValue(result)
}

describe('RecognizeGuardPanel × PhotoGradeOverlay · 自动终态结果', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/homework.png', size: 3 })
    h.tutoringTips.mockResolvedValue({ knowledge_points: [], sections: [] })
  })

  it('已作答作业优先展示服务端不可变批注图，不在 WebView 重复画勾叉', async () => {
    const items = [
      {
        question: correctQuestion,
        status: 'correct',
        result_kind: 'assessment',
        grade: grade('agree', '8'),
      },
      {
        question: wrongQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: grade('disagree', '0.1', {
          wrong_step: '小数位数判断错误。',
          error_cause: '把百分之一看成十分之一。',
          record_created: true,
          record_id: 'mistake-1',
        }),
        parent_guide: guide(),
      },
    ]
    const dispatch = completedDispatch('completed_homework', [correctQuestion, wrongQuestion])
    installTerminal(dispatch, completedHomeworkResult({ items }))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="photo-grade-overlay"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="overlay-image"]').attributes('src')).toBe(
      'data:image/png;base64,QU5OT1RBVEVE',
    )
    expect(wrapper.findAll('.pg-overlay__mark')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="recognize-pipeline"]').exists()).toBe(false)

    const issue = wrapper.get('.grade-card--issue')
    expect(issue.attributes('open')).toBeDefined()
    for (const label of [
      '答案',
      '必要步骤',
      '本年级方法',
      '易错点',
      '家长怎么讲',
      '可以追问',
      '怎么检查',
    ]) {
      expect(issue.text()).toContain(label)
    }
    const correct = wrapper.get('.grade-card--correct')
    expect(correct.attributes('open')).toBeUndefined()
    expect(correct.text()).toContain('一. 1')
    expect(correct.text()).not.toContain('第 1 题')
  })

  it('旧服务没有批注图时才按可靠 bbox 做本地确定性叠加', async () => {
    const items = [
      {
        question: correctQuestion,
        status: 'correct',
        result_kind: 'assessment',
        grade: grade('agree', '8'),
      },
      {
        question: wrongQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: grade('disagree', '0.1', {
          error_cause: '小数点位置错误。',
        }),
        parent_guide: guide(),
      },
    ]
    const dispatch = completedDispatch('completed_homework', [correctQuestion, wrongQuestion])
    installTerminal(dispatch, completedHomeworkResult({ annotated: false, items }))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('[data-testid="overlay-image"]').attributes('src')).toBe(
      'data:image/png;base64,T1JJR0lOQUw=',
    )
    expect(wrapper.findAll('.pg-overlay__mark')).toHaveLength(2)
    expect(wrapper.get('[data-testid="overlay-sym-0"]').text()).toBe('✓')
    expect(wrapper.get('[data-testid="overlay-sym-1"]').text()).toBe('✗')

    await wrapper.get('[data-testid="overlay-toggle"]').trigger('click')
    expect(wrapper.findAll('.pg-overlay__mark')).toHaveLength(0)
  })

  it('bbox 缺失时降级文字讲解，绝不猜坐标画错位红叉', async () => {
    const noBBoxQuestion = { ...wrongQuestion, bbox: undefined }
    const items = [
      {
        question: noBBoxQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: grade('disagree', '0.1', {
          error_cause: '小数点位置错误。',
        }),
        parent_guide: guide(),
      },
    ]
    const dispatch = completedDispatch('completed_homework', [noBBoxQuestion])
    installTerminal(dispatch, completedHomeworkResult({ annotated: false, items }))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('.pg-overlay__mark')).toHaveLength(0)
    expect(wrapper.get('[data-testid="overlay-degraded"]').text()).toContain('小数点位置错误')
    expect(wrapper.get('[data-testid="overlay-degraded-0"]').text()).toContain('10')
  })

  it('超出当前年级范围只给范围说明，不把它画成孩子答错', async () => {
    const items = [
      {
        question: wrongQuestion,
        status: 'out_of_scope',
        result_kind: 'out_of_scope',
        grade: grade('out_of_scope', '本题超出当前年级范围。', {
          out_of_scope_kp: '方程组',
        }),
      },
    ]
    const dispatch = completedDispatch('completed_homework', [wrongQuestion])
    installTerminal(dispatch, completedHomeworkResult({ annotated: false, items }))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('.pg-overlay__mark--wrong')).toHaveLength(0)
    expect(wrapper.get('[data-testid="overlay-degraded-0"]').text()).toContain('超出当前范围')
  })

  it('空白卷按原题顺序展示完整家长讲题指南，不复用批改图或逐题按钮', async () => {
    const blankOne = {
      ...correctQuestion,
      problem_id: 'blank-1',
      question: '4.5×2=',
      answer_state: 'blank',
      student_answer: '',
      bbox: undefined,
    }
    const blankTwo = {
      ...wrongQuestion,
      problem_id: 'blank-2',
      question: '15-5.7=',
      answer_state: 'blank',
      student_answer: '',
      bbox: undefined,
    }
    const dispatch = completedDispatch('blank_worksheet', [blankOne, blankTwo])
    installTerminal(dispatch, {
      dispatch_id: 'dispatch-result',
      task_intent: 'blank_worksheet',
      status: 'routed',
      result: {
        kind: 'blank_worksheet',
        payload: {
          mode: 'solve',
          task_intent: 'blank_worksheet',
          result_surface: 'parent_teaching_guide',
          items: [
            {
              question: blankOne,
              status: 'blank_solved',
              result_kind: 'parent_teaching_guide',
              parent_guide: guide('9'),
            },
            {
              question: blankTwo,
              status: 'blank_solved',
              result_kind: 'parent_teaching_guide',
              parent_guide: guide('9.3'),
            },
          ],
          markdown: '# 家长讲题指南',
          image_warning: '',
        },
      },
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="blank-worksheet-guide-item"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="blank-worksheet-parent-guide"]').text()).toContain(
      '已按原题顺序自动解答 2 题',
    )
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-grade-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-solve-"]').exists()).toBe(false)
    expect(h.grade).not.toHaveBeenCalled()
    expect(h.solve).not.toHaveBeenCalled()
  })
})
