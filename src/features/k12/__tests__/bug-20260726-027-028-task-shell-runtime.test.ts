import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const api = vi.hoisted(() => ({
  upload: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
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
  k12UploadAsset: (...args: unknown[]) => api.upload(...args),
  k12CreateImageTask: (...args: unknown[]) => api.create(...args),
  k12GetImageTask: (...args: unknown[]) => api.get(...args),
  k12GetImageTaskResult: vi.fn(),
  k12ConfirmImageTask: vi.fn(),
  k12RetryImageTask: vi.fn(),
  k12CancelImageTask: vi.fn(),
  k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
  k12SubmitImageTaskProblemSourceAction: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

describe('BUG-20260726-027/028 · active TaskShell runtime feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000 * 1000))
    api.upload.mockReset().mockResolvedValue({ asset_id: 'asset://mingming/homework.png', size: 3 })
    api.create.mockReset().mockResolvedValue({
      created: true,
      dispatch: {
        dispatch_id: 'dispatch-running',
        task_intent: 'completed_homework',
        status: 'routed',
        intent_evidence: ['answer_regions_present'],
        intent_confidence: 0.99,
        confirmation_candidates: [],
        target: { type: 'homework_submission', id: 'submission-running' },
        target_projection: {
          kind: 'homework',
          stage: 'locating',
          confirmation_state: 'confirmed',
          anchor_state: 'pending',
          recognition: {
            subject: '数学',
            questions: [
              {
                problem_id: 'problem-1',
                question: '4 ÷ 0.5 =',
                knowledge_points: ['小数除法'],
                answer_state: 'present',
                student_answer: '8',
                confirmation_required: false,
              },
            ],
          },
        },
        progress: { operation: 'homework', state: 'locating' },
        version: 7,
        created_at: 999_958,
        updated_at: 1_000_000,
        automatic_budget_seconds: 300,
        automatic_started_at: 999_958,
        automatic_deadline_at: 1_000_258,
        automatic_remaining_seconds: 258,
        operation_deadline_at: 1_000_018,
      },
    })
    api.get.mockReset().mockReturnValue(new Promise(() => {}))
  })

  it('shows the approved shared dots and persisted elapsed/stage budget in the active branch', async () => {
    const wrapper = mount(RecognizeGuardPanel, {
      props: {
        agentId: 'mingming',
        grade: '五年级下',
        sessionId: 'session-running',
        requestId: 'message-running',
        sourceMessageId: 'message-running',
        initialImage: 'data:image/png;base64,QUJD',
      },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()

    const branch = wrapper.get('[data-testid="recognize-anchor-branch"]')
    expect(branch.findAll('.hc-typing-dots__dot')).toHaveLength(3)
    expect(branch.text()).toContain('已等待 00:42 · 阶段预算 60 秒')
  })
})
