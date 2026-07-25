import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'
import { K12_IMAGE_TASK_BINDINGS_KEY } from '../image-task-binding'
import apiSource from '@/api/k12.ts?raw'

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

import { useK12Store } from '../store'

const originalImage = 'data:image/png;base64,T1JJR0lOQUw='
const annotatedBase64 = 'QU5OT1RBVEVE'
const question = {
  problem_id: 'problem-1',
  question: '4÷0.5=',
  canonical_markdown: '4\\div0.5=',
  knowledge_points: ['小数除法'],
  answer_state: 'present',
  student_answer: '8',
  answer_canonical_markdown: '8',
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.08 },
}
const conflictQuestion = {
  ...question,
  confirmation_required: true,
  confirmation_reasons: ['decimal_point'],
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function status(
  stage: string,
  confirmationState: 'pending' | 'confirmed' = 'confirmed',
  extra: Record<string, unknown> = {},
) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-1',
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
        ...extra,
      },
      progress: { operation: 'homework', state: stage },
      version: 1,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function terminalResult() {
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
            question,
            status: 'correct',
            grade: {
              solution: '8',
              verdict: 'agree',
              evidence_type: 'numeric_exec',
              badge: 'agree',
              out_of_scope: false,
            },
          },
        ],
        markdown: '# 批改完成',
        annotated_image: {
          mime: 'image/png',
          data_base64: annotatedBase64,
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
      initialImage: originalImage,
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

function mountRestoredPanel() {
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      grade: '五年级下',
      sessionId: 'session-1',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('BUG-20260724-011/013/015 · TaskShell 与同 dispatch 结果恢复', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.uploadAsset.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('会话内图片任务只渲染一个 TaskShell 关闭控件，不挂载隐藏输入清空按钮', async () => {
    h.createTask.mockResolvedValue({ created: true, ...status('queued', 'pending') })
    h.getTask.mockResolvedValue(
      status('awaiting_confirmation', 'pending', {
        recognition: { questions: [conflictQuestion], subject: '数学' },
      }),
    )

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="recognize-close"]')).toHaveLength(1)
    expect(wrapper.findAll('.hc-clearable-field__button')).toHaveLength(0)
  })

  it('TaskShell 关闭只在原位收起，后台等待和服务端任务都不取消', async () => {
    h.createTask.mockResolvedValue({ created: true, ...status('queued', 'pending') })
    h.getTask.mockImplementation(() => new Promise(() => {}))

    const wrapper = mountPanel()
    await flushPromises()
    const toggle = wrapper.get('[data-testid="recognize-close"]')
    await toggle.trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.classes()).toContain('rec-panel--collapsed')
    expect(toggle.attributes('aria-label')).toBe('展开任务')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).toContain('任务已收起 · 后台继续处理')
    await toggle.trigger('click')
    expect(wrapper.classes()).not.toContain('rec-panel--collapsed')
    expect(toggle.attributes('aria-label')).toBe('收起任务')
    wrapper.unmount()
    await flushPromises()

    expect(h.cancelTask).not.toHaveBeenCalled()
  })

  it('家长确认后自动轮询同一个 dispatch 并渲染终态，不再要求第二次点击“批改整张作业”', async () => {
    vi.useFakeTimers()
    h.createTask.mockResolvedValue({ created: true, ...status('queued', 'pending') })
    h.getTask
      .mockResolvedValueOnce(
        status('awaiting_confirmation', 'pending', {
          recognition: { questions: [conflictQuestion], subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('assessing'))
      .mockResolvedValueOnce(status('completed'))
    h.confirmTask.mockResolvedValue(status('assessing'))
    h.getResult.mockResolvedValue(terminalResult())

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="rq-confirm-0"]').setValue(true)
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await vi.advanceTimersByTimeAsync(2_501)
    await flushPromises()

    expect(h.confirmTask).toHaveBeenCalledTimes(1)
    expect(h.getResult).toHaveBeenCalledWith('mingming', 'dispatch-1', expect.any(AbortSignal))
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
  })

  it('结果契约优先展示服务端不可变批注图，缺字段时才允许继续使用坐标叠加兼容层', async () => {
    vi.useFakeTimers()
    h.createTask.mockResolvedValue({ created: true, ...status('queued', 'pending') })
    h.getTask
      .mockResolvedValueOnce(
        status('awaiting_confirmation', 'pending', {
          recognition: { questions: [conflictQuestion], subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('completed'))
    h.confirmTask.mockResolvedValue(status('completed'))
    h.getResult.mockResolvedValue(terminalResult())

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="rq-confirm-0"]').setValue(true)
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(wrapper.get('[data-testid="overlay-image"]').attributes('src')).toBe(
      `data:image/png;base64,${annotatedBase64}`,
    )
    expect(wrapper.findAll('.pg-overlay__mark')).toHaveLength(0)
  })

  it('recovering 只作为同 dispatch 轮询中的恢复快照，随后 completed 自动返回结果', async () => {
    vi.useFakeTimers()
    h.getTask
      .mockResolvedValueOnce(status('assessing'))
      .mockResolvedValueOnce(status('recovering'))
      .mockResolvedValueOnce(status('completed'))
    h.getResult.mockResolvedValue(terminalResult())

    let settled = false
    const resultPromise = useK12Store()
      .completeImageTask('mingming', 'dispatch-1', { sourceSession: 'session-1' })
      .then((result) => {
        settled = true
        return result
      })

    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(settled).toBe(false)
    expect(h.getResult).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_001)
    await expect(resultPromise).resolves.toMatchObject({ stage: 'completed' })
    expect(h.getTask).toHaveBeenCalledTimes(3)
    expect(h.getResult).toHaveBeenCalledTimes(1)
    expect(h.retryTask).not.toHaveBeenCalled()
  })

  it('刷新恢复 unknown 只轮询绑定的同一 dispatch，零 create/retry/cancel/人工恢复入口并自动收敛', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      K12_IMAGE_TASK_BINDINGS_KEY,
      JSON.stringify({
        version: 1,
        bindings: {
          'session-1': { agent_id: 'mingming', dispatch_id: 'dispatch-1' },
        },
      }),
    )
    h.getTask
      .mockResolvedValueOnce(status('recovering'))
      .mockResolvedValueOnce(status('completed'))
      .mockResolvedValueOnce(status('completed'))
    h.getResult.mockResolvedValue(terminalResult())

    const wrapper = mountRestoredPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('正在恢复批改结果')
    expect(wrapper.find('[data-testid="recognize-stage-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-grade-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-solve-all"]').exists()).toBe(false)
    expect(
      wrapper
        .findAll('button')
        .filter((button) => button.isVisible())
        .map((button) => button.attributes('data-testid')),
    ).toEqual(['recognize-close'])
    expect(document.querySelector('[data-testid="recognize-outcome-dialog"]')).toBeNull()
    expect(h.createTask).not.toHaveBeenCalled()
    expect(h.retryTask).not.toHaveBeenCalled()
    expect(h.cancelTask).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_501)
    await flushPromises()

    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
    expect(h.getTask).toHaveBeenCalledTimes(3)
    expect(
      h.getTask.mock.calls.every(
        ([agent, dispatchId]) => agent === 'mingming' && dispatchId === 'dispatch-1',
      ),
    ).toBe(true)
    expect(h.createTask).not.toHaveBeenCalled()
    expect(h.retryTask).not.toHaveBeenCalled()
    expect(h.cancelTask).not.toHaveBeenCalled()
  })

  it('恢复期间只显示瞬时进度，不再提供永久“结果待核实”卡和只读详情弹窗', async () => {
    vi.useFakeTimers()
    h.createTask.mockResolvedValue({ created: true, ...status('queued', 'pending') })
    h.getTask
      .mockResolvedValueOnce(
        status('awaiting_confirmation', 'pending', {
          recognition: { questions: [conflictQuestion], subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('recovering'))
      .mockResolvedValueOnce(status('completed'))
    h.confirmTask.mockResolvedValue(status('assessing'))
    h.getResult.mockResolvedValue(terminalResult())

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="rq-confirm-0"]').setValue(true)
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(wrapper.text()).toContain('正在恢复批改结果')
    expect(wrapper.text()).not.toContain('结果待核实')
    expect(wrapper.find('[data-testid="recognize-outcome-status"]').exists()).toBe(false)
    expect(document.querySelector('[data-testid="recognize-outcome-dialog"]')).toBeNull()

    await vi.advanceTimersByTimeAsync(2_501)
    await flushPromises()
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
  })

  it('TypeScript API 明确声明不可变批注图 wire 字段', () => {
    expect(apiSource).toMatch(
      /annotated_image\?:\s*\{[\s\S]*mime:\s*string[\s\S]*data_base64:\s*string[\s\S]*digest\?:\s*string/,
    )
  })
})
