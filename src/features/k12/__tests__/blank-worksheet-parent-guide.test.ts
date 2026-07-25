import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const h = vi.hoisted(() => ({
  uploadAsset: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  getResult: vi.fn(),
  confirmTask: vi.fn(),
  retryTask: vi.fn(),
  cancelTask: vi.fn(),
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
  k12UploadAsset: (...args: unknown[]) => h.uploadAsset(...args),
  k12CreateImageTask: (...args: unknown[]) => h.createTask(...args),
  k12GetImageTask: (...args: unknown[]) => h.getTask(...args),
  k12GetImageTaskResult: (...args: unknown[]) => h.getResult(...args),
  k12ConfirmImageTask: (...args: unknown[]) => h.confirmTask(...args),
  k12RetryImageTask: (...args: unknown[]) => h.retryTask(...args),
  k12CancelImageTask: (...args: unknown[]) => h.cancelTask(...args),
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

const questions = [
  {
    problem_id: 'p-1',
    question: '4.5 × 2 =',
    canonical_markdown: '4.5 \\times 2 =',
    knowledge_points: ['小数乘法'],
    answer_state: 'blank',
  },
  {
    problem_id: 'p-2',
    question: '15 − 5.7 =',
    canonical_markdown: '15 - 5.7 =',
    knowledge_points: ['小数减法'],
    answer_state: 'blank',
  },
]

function completedStatus() {
  return {
    dispatch: {
      dispatch_id: 'blank-dispatch-1',
      task_intent: 'blank_worksheet',
      status: 'routed',
      intent_evidence: ['no_answer_regions'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage: 'completed',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        recognition: { questions, subject: '数学' },
      },
      progress: { operation: 'homework', state: 'completed' },
      version: 1,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function blankResult() {
  return {
    dispatch_id: 'blank-dispatch-1',
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
            question: questions[0],
            status: 'blank_solved',
            result_kind: 'parent_teaching_guide',
            parent_guide: {
              answer: '9',
              full_solution_steps: ['先算 45 × 2 = 90', '按一个小数位点回小数点，得到 9'],
              grade_level_method: '先按整数乘法算，再数小数位。',
              likely_mistakes: ['忘记点回小数点'],
              parent_teaching_sequence: ['先让孩子算 45 × 2', '再让孩子自己点小数点'],
              follow_up_questions: ['0.45 × 2 的小数点应放在哪里？'],
              checking_method: '用 9 ÷ 2 反算。',
            },
          },
          {
            question: questions[1],
            status: 'blank_solved',
            result_kind: 'parent_teaching_guide',
            parent_guide: {
              answer: '9.3',
              full_solution_steps: ['把 15 写成 15.0', '小数点对齐后计算 15.0 − 5.7 = 9.3'],
              grade_level_method: '小数加减法先对齐小数点。',
              likely_mistakes: ['把最右边数字对齐'],
              parent_teaching_sequence: ['先问 15 可以怎样写成小数', '让孩子对齐小数点'],
              follow_up_questions: ['为什么要对齐小数点？'],
              checking_method: '用 9.3 + 5.7 反算。',
            },
          },
        ],
        markdown: '',
        image_warning: '',
      },
    },
  }
}

describe('K12-INV-060 · 空白卷家长讲题结果投影', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.uploadAsset.mockResolvedValue({ asset_id: 'asset://mingming/blank.png', size: 3 })
    h.createTask.mockResolvedValue({ created: true, ...completedStatus() })
    h.getTask.mockResolvedValue(completedStatus())
    h.getResult.mockResolvedValue(blankResult())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('整页空白卷完成后按原题顺序自动显示七项家长讲题卡，不再要求逐题确认或操作', async () => {
    const wrapper = mount(RecognizeGuardPanel, {
      props: {
        agentId: 'mingming',
        grade: '五年级上',
        sessionId: 'session-1',
        requestId: 'message-1',
        initialImage: 'data:image/png;base64,AAAA',
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    await flushPromises()
    await flushPromises()

    const guide = wrapper.get('[data-testid="blank-worksheet-parent-guide"]')
    expect(guide.text()).toContain('空白卷 · 家长讲题指南')
    const cards = guide.findAll('[data-testid="blank-worksheet-guide-item"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('4.5 × 2 =')
    expect(cards[1]!.text()).toContain('15 − 5.7 =')
    for (const label of [
      '答案',
      '必要步骤',
      '本年级方法',
      '易错点',
      '家长怎么讲',
      '可以追问',
      '怎么检查',
    ]) {
      expect(cards[0]!.text()).toContain(label)
      expect(
        cards[0]!
          .findAll('.grade-card__row > span')
          .filter((node) => node.text() === label),
      ).toHaveLength(1)
    }
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(false)
    expect(h.confirmTask).not.toHaveBeenCalled()
  })

  it('任一题缺失完整七项时整页 fail-closed，不把部分指南冒充完成', async () => {
    const incomplete = blankResult()
    incomplete.result.payload.items.push({
      question: {
        problem_id: 'p-3',
        question: '7.2 × 0.8 =',
        canonical_markdown: '7.2 \\times 0.8 =',
        knowledge_points: ['小数乘法'],
        answer_state: 'blank',
      },
      status: 'blank_solved',
      result_kind: 'parent_teaching_guide',
      parent_guide: {
        answer: '5.76',
        full_solution_steps: ['先按整数乘法计算。'],
        grade_level_method: '按本年级小数乘法方法。',
        likely_mistakes: ['小数点位置错误。'],
        parent_teaching_sequence: [],
        follow_up_questions: ['怎样反向验算？'],
        checking_method: '用除法验算。',
      },
    })
    h.getResult.mockResolvedValue(incomplete)

    const wrapper = mount(RecognizeGuardPanel, {
      props: {
        agentId: 'mingming',
        grade: '五年级上',
        sessionId: 'session-1',
        requestId: 'message-1',
        initialImage: 'data:image/png;base64,AAAA',
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    await flushPromises()
    await flushPromises()

    expect(wrapper.find('[data-testid="blank-worksheet-parent-guide"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="blank-worksheet-guide-item"]')).toHaveLength(0)
    expect(wrapper.find('.rec-panel__err').exists()).toBe(true)
  })
})
