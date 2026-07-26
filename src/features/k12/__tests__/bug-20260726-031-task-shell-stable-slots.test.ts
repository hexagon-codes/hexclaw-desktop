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

function question(problemId: string, label: string, path: string[]) {
  return {
    problem_id: problemId,
    source_number_path: path,
    display_label: label,
    question: `${label} 题目`,
    knowledge_points: ['小数计算'],
    answer_state: 'present',
    student_answer: '8',
    confirmation_required: false,
  }
}

function progressiveDispatch() {
  const questions = [
    question('problem-1', '一. 1', ['一', '1']),
    question('problem-2', '一. 2', ['一', '2']),
    question('problem-3', '二. 1', ['二', '1']),
  ]
  return {
    created: true,
    dispatch: {
      dispatch_id: 'dispatch-progressive-slots',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-progressive' },
      target_projection: {
        kind: 'homework',
        stage: 'assessing',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        structure_version: 1,
        recognition: { subject: '数学', questions },
        // Deliberately callback/completion order, never source order.
        problems: [
          {
            problem_id: 'problem-3',
            source_number_path: ['二', '1'],
            display_label: '二. 1',
            source_state: 'ready',
            anchor_state: 'located',
            operation_state: 'published',
            disposition_state: 'result',
            result_projection: null,
            published_revision: 3,
          },
          {
            problem_id: 'problem-1',
            source_number_path: ['一', '1'],
            display_label: '一. 1',
            source_state: 'ready',
            anchor_state: 'located',
            operation_state: 'published',
            disposition_state: 'result',
            result_projection: null,
            published_revision: 2,
          },
          {
            problem_id: 'problem-2',
            source_number_path: ['一', '2'],
            display_label: '一. 2',
            source_state: 'ready',
            anchor_state: 'located',
            operation_state: 'assessing',
            disposition_state: 'pending',
            result_projection: null,
            published_revision: 0,
          },
        ],
        coverage: { state: 'incomplete', total: 3, processed: 2, skipped: 0 },
        projection_revision: 3,
        final_artifact: null,
      },
      progress: { operation: 'homework', state: 'assessing' },
      version: 3,
      created_at: 1,
      updated_at: 2,
    },
  }
}

describe('BUG-20260726-031 · TaskShell stable problem slots', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
    h.create.mockResolvedValue(progressiveDispatch())
    h.get.mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('BUG-20260726-031 renders every frozen problem once in source order, not callback order', async () => {
    const wrapper = mount(RecognizeGuardPanel, {
      props: {
        agentId: 'mingming',
        grade: '五年级下',
        sessionId: 'session-progressive',
        requestId: 'message-progressive',
        initialImage: 'data:image/png;base64,QUJD',
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    const progressList = wrapper.element.querySelector('[role="list"]') as HTMLElement | null
    expect(
      progressList,
      'TaskShell must expose one accessible list for the frozen problem slots',
    ).not.toBeNull()

    const slots = [
      ...progressList!.querySelectorAll('[role="listitem"]'),
    ] as HTMLElement[]
    expect(slots).toHaveLength(3)
    expect(slots.map((slot) => slot.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('一. 1'),
      expect.stringContaining('一. 2'),
      expect.stringContaining('二. 1'),
    ])

    wrapper.unmount()
  })
})
