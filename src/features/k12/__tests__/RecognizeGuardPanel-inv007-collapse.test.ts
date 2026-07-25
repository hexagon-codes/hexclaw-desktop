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
  question: '516-356=160',
  canonical_markdown: '516-356=160',
  knowledge_points: ['整数减法'],
  answer_state: 'present',
  student_answer: '160',
  confirmation_required: false,
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.06 },
}

const wrongQuestion = {
  problem_id: 'p-wrong',
  question: '10×0.01=1',
  canonical_markdown: '10\\times0.01=1',
  knowledge_points: ['小数乘法'],
  answer_state: 'present',
  student_answer: '1',
  confirmation_required: false,
  bbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.06 },
}

const riskQuestion = {
  ...wrongQuestion,
  confirmation_required: true,
  confirmation_reasons: ['decimal_point'],
}

const parentGuide = {
  answer: '0.1',
  full_solution_steps: ['先看 0.01 的意义。', '再按位值计算。'],
  grade_level_method: '用五年级小数乘法方法。',
  likely_mistakes: ['把百分之一看成十分之一。'],
  parent_teaching_sequence: ['先复述题意。', '再用位值表重算。'],
  follow_up_questions: ['100×0.01 等于多少？'],
  checking_method: '用逆运算验算。',
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function dispatch(
  taskIntent: 'completed_homework' | 'blank_worksheet',
  stage: 'awaiting_confirmation' | 'completed',
  questions: Array<Record<string, unknown>>,
) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-1',
      task_intent: taskIntent,
      status: stage === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'routed',
      intent_evidence: ['image_evidence'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage,
        confirmation_state: stage === 'completed' ? 'confirmed' : 'pending',
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

function grade(
  verdict: 'agree' | 'disagree',
  solution: string,
  extra: Record<string, unknown> = {},
) {
  return {
    solution,
    verdict,
    evidence_type: 'numeric_exec',
    badge: verdict === 'agree' ? 'verified-strong' : 'disagree',
    out_of_scope: false,
    record_created: false,
    ...extra,
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

describe('RecognizeGuardPanel · TaskShell 与正确题折叠不变量', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/homework.png', size: 3 })
    h.tutoringTips.mockResolvedValue({ knowledge_points: [], sections: [] })
  })

  it('整个图片任务只有一个 X；收起只折叠原位内容，后台任务不取消', async () => {
    h.create.mockResolvedValue({
      created: true,
      ...dispatch('completed_homework', 'awaiting_confirmation', [riskQuestion]),
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="recognize-close"]')).toHaveLength(1)
    expect(wrapper.findAll('.hc-clearable-field__button')).toHaveLength(0)
    const close = wrapper.get('[data-testid="recognize-close"]')
    expect(close.attributes('aria-label')).toBe('收起任务')
    expect(close.attributes('aria-expanded')).toBe('true')

    await close.trigger('click')
    expect(wrapper.classes()).toContain('rec-panel--collapsed')
    expect(close.attributes('aria-label')).toBe('展开任务')
    expect(close.attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).toContain('任务已收起 · 后台继续处理')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(h.cancel).not.toHaveBeenCalled()

    await close.trigger('click')
    expect(wrapper.classes()).not.toContain('rec-panel--collapsed')
    expect(close.attributes('aria-label')).toBe('收起任务')
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it('整卷自动批改结果中正确题默认折叠，错题与家长讲法默认展开', async () => {
    const completed = dispatch('completed_homework', 'completed', [
      correctQuestion,
      wrongQuestion,
    ])
    h.create.mockResolvedValue({ created: true, ...completed })
    h.get.mockResolvedValue(completed)
    h.getResult.mockResolvedValue({
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
              question: correctQuestion,
              status: 'correct',
              result_kind: 'assessment',
              grade: grade('agree', '160'),
            },
            {
              question: wrongQuestion,
              status: 'wrong',
              result_kind: 'assessment',
              grade: grade('disagree', '0.1', {
                wrong_step: '小数点位置错误。',
                error_cause: '把百分之一看成十分之一。',
              }),
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
    })

    const wrapper = mountPanel()
    await flushPromises()

    const correct = wrapper.get('.grade-card--correct')
    const issue = wrapper.get('.grade-card--issue')
    expect(correct.attributes('open')).toBeUndefined()
    expect(correct.text()).toContain('第 1 题')
    expect(correct.text()).toContain('516')
    expect(issue.attributes('open')).toBeDefined()
    expect(issue.text()).toContain('把百分之一看成十分之一')
    expect(issue.text()).toContain('家长怎么讲')
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(h.grade).not.toHaveBeenCalled()
  })

  it('空白卷每题家长讲法默认展开，不套用“正确题折叠”或批改结论', async () => {
    const blankQuestion = {
      ...correctQuestion,
      problem_id: 'blank-1',
      question: '516-356=',
      answer_state: 'blank',
      student_answer: '',
      bbox: undefined,
    }
    const completed = dispatch('blank_worksheet', 'completed', [blankQuestion])
    h.create.mockResolvedValue({ created: true, ...completed })
    h.get.mockResolvedValue(completed)
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
          items: [
            {
              question: blankQuestion,
              status: 'blank_solved',
              result_kind: 'parent_teaching_guide',
              parent_guide: {
                ...parentGuide,
                answer: '160',
                full_solution_steps: ['个位相减。', '十位退位后再相减。', '百位相减。'],
              },
            },
          ],
          markdown: '# 家长讲题指南',
          image_warning: '',
        },
      },
    })

    const wrapper = mountPanel()
    await flushPromises()

    const guide = wrapper.get('[data-testid="blank-worksheet-guide-item"]')
    expect(guide.attributes('open')).toBeDefined()
    expect(guide.text()).toContain('160')
    expect(guide.text()).toContain('家长怎么讲')
    expect(wrapper.find('.grade-card--correct').exists()).toBe(false)
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="rq-solve-"]').exists()).toBe(false)
    expect(h.solve).not.toHaveBeenCalled()
  })
})
