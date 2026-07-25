import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const correctQuestion = {
  problem_id: 'p-correct',
  question: '4÷0.5=',
  canonical_markdown: '4\\div 0.5=',
  knowledge_points: ['小数除法'],
  answer_state: 'present',
  student_answer: '8',
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.06 },
}

const wrongQuestion = {
  problem_id: 'p-wrong',
  question: '10×0.01=',
  canonical_markdown: '10\\times 0.01=',
  knowledge_points: ['小数乘法'],
  answer_state: 'present',
  student_answer: '1',
  bbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.06 },
}

const parentGuide = {
  answer: '0.1',
  full_solution_steps: ['先看 0.01 表示百分之一。', '10 个百分之一是 0.1。'],
  grade_level_method: '用五年级小数乘法理解小数位数。',
  likely_mistakes: ['把乘以 0.01 当成乘以 0.1。'],
  parent_teaching_sequence: ['先让孩子说出 0.01 的意义。', '再用位值表重算。'],
  follow_up_questions: ['100×0.01 等于多少？为什么？'],
  checking_method: '用 0.1÷0.01=10 反向验算。',
}

function completedDispatch() {
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
        stage: 'completed',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        recognition: { subject: '数学', questions: [correctQuestion, wrongQuestion] },
      },
      progress: { operation: 'homework', state: 'completed' },
      version: 2,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function result() {
  return {
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
            question: correctQuestion,
            status: 'correct',
            result_kind: 'assessment',
            grade: {
              solution: '8',
              verdict: 'agree',
              evidence_type: 'numeric_exec',
              badge: 'verified-strong',
              out_of_scope: false,
              record_created: false,
              solve_only: false,
            },
          },
          {
            question: wrongQuestion,
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
              solve_only: false,
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

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

describe('completed_homework single annotated result surface', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/homework.png', size: 3 })
    h.create.mockResolvedValue({ created: true, ...completedDispatch() })
    h.get.mockResolvedValue(completedDispatch())
    h.getResult.mockResolvedValue(result())
  })

  it('shows annotated image and summary first, wrong seven-field guide once, and correct items collapsed', async () => {
    const wrapper = mount(RecognizeGuardPanel, {
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

    await flushPromises()
    await flushPromises()

    const resultSurface = wrapper.get('[data-testid="photo-grade-overlay"]')
    expect(wrapper.findAll('[data-testid="photo-grade-overlay"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="recognize-pipeline"]').exists()).toBe(false)
    expect(resultSurface.get('[data-testid="overlay-image"]').attributes('src')).toBe(
      'data:image/png;base64,QU5OT1RBVEVE',
    )

    const issue = resultSurface.get('.grade-card--issue')
    const labels = issue.findAll('.grade-card__row > span').map((node) => node.text())
    for (const label of [
      '答案',
      '必要步骤',
      '本年级方法',
      '易错点',
      '家长怎么讲',
      '可以追问',
      '怎么检查',
    ]) {
      expect(labels.filter((value) => value === label)).toHaveLength(1)
    }
    expect(issue.text()).toContain('先让孩子说出 0.01 的意义。')

    const correct = resultSurface.get('.grade-card--correct')
    expect(correct.attributes('open')).toBeUndefined()
    expect(correct.text()).toContain('第 1 题')
    expect(correct.text()).toContain('0.5')
  })
})
