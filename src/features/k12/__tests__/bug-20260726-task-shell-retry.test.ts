import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
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

  function dispatch(
    stage: 'failed_retryable' | 'failed_terminal' | 'recovering' | 'outcome_unknown',
    retryable: boolean,
  ) {
  return {
    created: true,
    dispatch: {
      dispatch_id: 'dispatch-1',
      task_intent: 'completed_homework',
      status: 'routed',
      retryable,
      intent_evidence: [],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage,
        confirmation_state: 'confirmed',
        anchor_state: 'located',
      },
      progress: { operation: 'homework', state: stage },
      version: 2,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function render(
  stage: 'failed_retryable' | 'failed_terminal' | 'recovering' | 'outcome_unknown',
  retryable: boolean,
) {
  h.createTask.mockResolvedValue(dispatch(stage, retryable))
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      requestId: 'message-1',
      initialImage: 'data:image/png;base64,Zm9v',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('BUG-20260726-010 · TaskShell retry capability', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.uploadAsset.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
  })

  it.each([
    ['failed_retryable', false],
    ['failed_terminal', false],
    ['recovering', false],
    ['outcome_unknown', false],
  ] as const)('%s + retryable=%s 不显示伪重试且状态可见', async (stage, retryable) => {
    const wrapper = render(stage, retryable)
    await flushPromises()

    expect(wrapper.find('[data-testid="message-regenerate"]').exists()).toBe(false)
    expect(wrapper.find('[role="status"], [role="alert"]').exists()).toBe(true)
    expect(h.retryTask).not.toHaveBeenCalled()
    expect(h.createTask).toHaveBeenCalledTimes(1)
  })

  it('failed_retryable + retryable=true 点击立即反馈，双击只提交一次', async () => {
    let resolveRetry!: (value: unknown) => void
    h.retryTask.mockImplementation(
      () => new Promise((resolve) => {
        resolveRetry = resolve
      }),
    )
    const wrapper = render('failed_retryable', true)
    await flushPromises()

    await wrapper.setProps({
      agentDisplayName: '小王的辅导助手',
      displayProvider: 'HexClaw-GPT',
      displayModel: 'gpt-5.6-sol',
      grade: '五年级下',
    })
    const metadata = wrapper.get('[data-testid="task-shell-metadata"]')
    expect(metadata.findAll('span')[0]?.text().trim()).not.toBe('')
    expect(metadata.text()).toContain('HexClaw-GPT')
    expect(metadata.text()).toContain('gpt-5.6-sol')
    expect(metadata.text()).toContain('小王的辅导助手')
    expect(metadata.text()).toContain('五年级下')

    const retry = wrapper.get('[data-testid="message-regenerate"]')
    await Promise.all([retry.trigger('click'), retry.trigger('click')])

    expect(h.retryTask).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="recognize-retry-processing"]').text()).not.toBe('')

    resolveRetry(dispatch('recovering', false))
    await flushPromises()
    expect(wrapper.find('[data-testid="message-regenerate"]').exists()).toBe(false)
  })
})
