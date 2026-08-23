import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const h = vi.hoisted(() => ({
  getTask: vi.fn(),
  getResult: vi.fn(),
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
  k12UploadAsset: vi.fn(),
  k12CreateImageTask: vi.fn(),
  k12GetImageTask: (...args: unknown[]) => h.getTask(...args),
  k12GetImageTaskResult: (...args: unknown[]) => h.getResult(...args),
  k12ConfirmImageTask: vi.fn(),
  k12RetryImageTask: vi.fn(),
  k12CancelImageTask: vi.fn(),
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

function creativeDispatch(state: 'feedback_pending' | 'recovering' | 'feedback_ready') {
  return {
    dispatch: {
      dispatch_id: 'dispatch-creative-1',
      task_intent: 'artwork',
      status: 'routed',
      intent_evidence: ['artwork_detected'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'creative_work_intake', id: 'intake-1' },
      target_projection: {
        kind: 'creative',
        intake_id: 'intake-1',
        work_type: 'art',
        status: 'promoted',
        work: { work_id: 'work-creative-1', display_name: '彩虹和小猫' },
      },
      progress: { operation: 'promotion', state },
      version: 3,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function creativeResult() {
  return {
    dispatch_id: 'dispatch-creative-1',
    task_intent: 'artwork',
    status: 'routed',
    result: {
      kind: 'artwork',
      payload: {
        intake: { intake_id: 'intake-1', status: 'promoted' },
        work: { work_id: 'work-creative-1', display_name: '彩虹和小猫' },
        feedback: {
          generation_id: 'generation-creative-1',
          structured_feedback: {
            feedback_id: 'feedback-creative-1',
            version_id: 'version-creative-1',
            feedback_type: 'art',
            evidence_refs: ['asset-ref:sha256:creative-1'],
            observations: [{ dimension: '构图', evidence: '彩虹在画面上方。' }],
            source_snapshot: {
              source: 'ai',
              method_ref: 'art-feedback@1.0.0',
              capability: 'art_feedback',
            },
            limitations: '只依据当前照片中可见的画面。',
            suggestions: ['保留彩虹的颜色层次。'],
            projection_markdown: '## 可见证据\n\n彩虹在画面上方。',
          },
          projection_markdown: '## 可见证据\n\n彩虹在画面上方。',
        },
      },
    },
  }
}

describe('BUG-20260726-007 creative feedback restart recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.getTask.mockReset()
    h.getResult.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-mounts the same dispatch and restores its canonical feedback identity and projection', async () => {
    vi.useFakeTimers()
    h.getTask
      .mockResolvedValueOnce(creativeDispatch('feedback_pending'))
      .mockResolvedValueOnce(creativeDispatch('recovering'))
      .mockResolvedValueOnce(creativeDispatch('feedback_ready'))
      .mockResolvedValueOnce(creativeDispatch('feedback_ready'))
    h.getResult.mockResolvedValue(creativeResult())

    const wrapper = mount(RecognizeGuardPanel, {
      props: {
        agentId: 'mingming',
        sessionId: 'session-creative-1',
        sourceMessageId: 'message-creative-1',
        restoreDispatchId: 'dispatch-creative-1',
      },
      global: { plugins: [createPinia(), i18n()] },
    })

    await vi.advanceTimersByTimeAsync(5_001)
    await flushPromises()

    expect(h.getTask).toHaveBeenCalledTimes(4)
    expect(
      h.getTask.mock.calls.every(
        ([agent, dispatchId]) => agent === 'mingming' && dispatchId === 'dispatch-creative-1',
      ),
    ).toBe(true)
    expect(h.getResult).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-generation-id="generation-creative-1"]').attributes('data-feedback-id')).toBe(
      'feedback-creative-1',
    )
    expect(wrapper.text()).toContain('彩虹在画面上方。')
  })
})
