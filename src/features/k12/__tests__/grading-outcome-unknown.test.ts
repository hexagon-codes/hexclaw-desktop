import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'
import apiSource from '@/api/k12.ts?raw'
import storeSource from '../store.ts?raw'
import { K12_IMAGE_TASK_BINDINGS_KEY } from '../image-task-binding'

const STORAGE_KEY = K12_IMAGE_TASK_BINDINGS_KEY

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

const question = {
  problem_id: 'p-1',
  question: '3.8×3=?',
  canonical_markdown: '3.8\\times3=?',
  knowledge_points: ['小数乘法'],
  answer_state: 'present',
  student_answer: '10.4',
  bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
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
      dispatch_id: 'dispatch-unknown',
      task_intent: 'completed_homework',
      status: stage === 'cancelled' ? 'cancelled' : stage.startsWith('failed') ? 'failed' : 'routed',
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

function result() {
  return {
    dispatch_id: 'dispatch-unknown',
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
            status: 'wrong',
            result_kind: 'assessment',
            grade: {
              solution: '11.4',
              verdict: 'disagree',
              evidence_type: 'numeric_exec',
              badge: 'disagree',
              error_cause: '小数点位置错误',
              out_of_scope: false,
              record_created: true,
            },
            parent_guide: {
              answer: '11.4',
              full_solution_steps: ['先对齐小数点。', '再按整数减法计算。'],
              grade_level_method: '使用五年级小数减法方法。',
              likely_mistakes: ['小数点没有对齐。'],
              parent_teaching_sequence: ['让孩子先读题。', '定位小数点。', '完成后反向验算。'],
              follow_up_questions: ['为什么小数点必须对齐？'],
              checking_method: '用差加减数还原被减数。',
            },
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

function bind(agent = 'mingming') {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      bindings: { 'session-1': { agent_id: agent, dispatch_id: 'dispatch-unknown' } },
    }),
  )
}

function mountRestoredPanel() {
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      grade: '五年级上',
      sessionId: 'session-1',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('K12 整卷批改 recovering 恢复语义', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.uploadAsset.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('公开投影只暴露 recovering 瞬时阶段，facade 结果契约不把它定义为业务结果', () => {
    const block =
      apiSource.match(/export type ImageTaskHomeworkStage\s*=([\s\S]*?)\n\n/)?.[1] ?? ''
    expect(block).toContain("'recovering'")
    expect(block).not.toContain("'outcome_unknown'")
    expect(storeSource).toMatch(
      /export type ImageTaskCompletionOutcome\s*=/,
    )
  })

  it('同一 dispatch 从 recovering 恢复到 completed，不 confirm/retry/create', async () => {
    vi.useFakeTimers()
    h.getTask
      .mockResolvedValueOnce(status('assessing'))
      .mockResolvedValueOnce(status('recovering'))
      .mockResolvedValueOnce(status('completed'))
    h.getResult.mockResolvedValue(result())

    const promise = useK12Store().completeImageTask('mingming', 'dispatch-unknown', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(h.getResult).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_001)

    await expect(promise).resolves.toMatchObject({ stage: 'completed' })
    expect(h.getTask).toHaveBeenCalledTimes(3)
    expect(h.confirmTask).not.toHaveBeenCalled()
    expect(h.retryTask).not.toHaveBeenCalled()
    expect(h.createTask).not.toHaveBeenCalled()
    expect(h.getResult).toHaveBeenCalledTimes(1)
  })

  it('已确认的活动图片任务只轮询并读取结果，不重复 confirm', async () => {
    h.getTask.mockResolvedValue(status('completed'))
    h.getResult.mockResolvedValue(result())

    await expect(
      useK12Store().completeImageTask('mingming', 'dispatch-unknown', {}),
    ).resolves.toMatchObject({ stage: 'completed' })
    expect(h.confirmTask).not.toHaveBeenCalled()
    expect(h.getResult).toHaveBeenCalledOnce()
  })

  it('恢复轮询响应 AbortSignal，中止后不再 GET/result/retry', async () => {
    vi.useFakeTimers()
    h.getTask.mockResolvedValue(status('recovering'))
    const controller = new AbortController()
    const promise = useK12Store().completeImageTask(
      'mingming',
      'dispatch-unknown',
      {},
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(5_001)
    expect(h.getTask).toHaveBeenCalledTimes(1)
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.retryTask).not.toHaveBeenCalled()
  })

  it('终态 result 请求透传 AbortSignal', async () => {
    h.getTask.mockResolvedValue(status('completed'))
    h.getResult.mockResolvedValue(result())
    const controller = new AbortController()

    await useK12Store().completeImageTask(
      'mingming',
      'dispatch-unknown',
      {},
      controller.signal,
    )

    expect(h.getResult).toHaveBeenCalledWith(
      'mingming',
      'dispatch-unknown',
      controller.signal,
    )
  })

  it('识题阶段 unknown 后仍只轮询原 dispatch，恢复停点后回显', async () => {
    vi.useFakeTimers()
    h.createTask.mockResolvedValue({ created: true, ...status('queued', 'pending') })
    h.getTask
      .mockResolvedValueOnce(status('recovering'))
      .mockResolvedValueOnce(
        status('awaiting_confirmation', 'pending', {
          recognition: { questions: [conflictQuestion], subject: '数学' },
        }),
      )

    const promise = useK12Store().dispatchImageTask({
      agent: 'mingming',
      dataUrl: 'data:image/png;base64,AAAA',
      sourceSession: 'session-1',
      sourceRef: 'message-1',
    })
    await vi.advanceTimersByTimeAsync(2_501)

    await expect(promise).resolves.toMatchObject({
      stage: 'awaiting_confirmation',
      dispatchId: 'dispatch-unknown',
    })
    expect(h.getTask).toHaveBeenCalledTimes(2)
    expect(h.confirmTask).not.toHaveBeenCalled()
    expect(h.retryTask).not.toHaveBeenCalled()
  })

  it('恢复组件把 unknown 投影为瞬时进度，completed 后自动展示同 dispatch 结果', async () => {
    vi.useFakeTimers()
    bind()
    h.getTask
      .mockResolvedValueOnce(
        status('recovering', 'confirmed', {
          recognition: { questions: [question], subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('completed'))
      .mockResolvedValueOnce(status('completed'))
    h.getResult.mockResolvedValue(result())

    const wrapper = mountRestoredPanel()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(wrapper.text()).toContain('正在恢复批改结果')
    expect(wrapper.text()).not.toContain('结果待核实')

    await vi.advanceTimersByTimeAsync(2_501)
    await flushPromises()
    expect(wrapper.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognize-outcome-status"]').exists()).toBe(false)
    expect(document.querySelector('[data-testid="recognize-outcome-dialog"]')).toBeNull()
    expect(h.createTask).not.toHaveBeenCalled()
    expect(h.retryTask).not.toHaveBeenCalled()
  })

  it('恢复 completed 返回终态，结果读取成功后仍保留同一 dispatch binding', async () => {
    bind()
    h.getTask.mockResolvedValue(status('completed'))
    const store = useK12Store()

    await expect(store.restoreImageTask('mingming', 'session-1')).resolves.toMatchObject({
      stage: 'completed',
    })
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()

    h.getResult.mockResolvedValue(result())
    await store.completeImageTask('mingming', 'dispatch-unknown', { sourceSession: 'session-1' })
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('恢复 awaiting_confirmation 回显既有识别结果，不创建新任务', async () => {
    bind()
    h.getTask.mockResolvedValue(
      status('awaiting_confirmation', 'pending', {
        recognition: { questions: [conflictQuestion], subject: '数学' },
      }),
    )

    const wrapper = mountRestoredPanel()
    await flushPromises()
    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it('跨孩子 binding fail-closed，不查询其他孩子的图片任务', async () => {
    bind('other-child')
    const wrapper = mountRestoredPanel()
    await flushPromises()
    expect(h.getTask).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="recognize-recovering"]').exists()).toBe(false)
  })

  it('组件卸载中止活动恢复轮询，不留下后台 GET', async () => {
    vi.useFakeTimers()
    bind()
    h.getTask.mockResolvedValue(status('assessing'))
    const wrapper = mountRestoredPanel()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.getTask).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(h.getTask).toHaveBeenCalledTimes(1)
  })

  it.each(['cancelled', 'failed_terminal', 'failed_retryable'])(
    '恢复确定失败态 %s 时保留 binding 供显式重试或核查',
    async (stage) => {
      bind()
      h.getTask.mockResolvedValue(status(stage))
      await expect(useK12Store().restoreImageTask('mingming', 'session-1')).resolves.toMatchObject({
        stage,
      })
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    },
  )

  it.each(['{bad json', JSON.stringify({ version: 2, bindings: {} })])(
    '损坏或未知版本 binding fail-closed 并清理：%s',
    async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw)
      await expect(useK12Store().restoreImageTask('mingming', 'session-1')).resolves.toBeNull()
      expect(h.getTask).not.toHaveBeenCalled()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    },
  )

  it('恢复 GET 404 清理同一 binding', async () => {
    bind()
    h.getTask.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    await expect(
      useK12Store().restoreImageTask('mingming', 'session-1'),
    ).resolves.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
