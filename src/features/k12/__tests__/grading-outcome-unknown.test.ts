import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'
import apiSource from '@/api/k12.ts?raw'
import { registerK12Scenario } from '../register'

const STORAGE_KEY = 'hexclaw.k12.grading-job-bindings.v1'

const h = vi.hoisted(() => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  getResult: vi.fn(),
  confirmJob: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  grade: vi.fn(),
  solve: vi.fn(),
  tutoringTips: vi.fn(),
  addGrounding: vi.fn(),
  coldStart: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12DeleteMistake: vi.fn(),
  k12TutoringTips: (...args: unknown[]) => h.tutoringTips(...args),
  k12AddGrounding: (...args: unknown[]) => h.addGrounding(...args),
  k12Grade: (...args: unknown[]) => h.grade(...args),
  k12RecordMistake: vi.fn(),
  k12Solve: (...args: unknown[]) => h.solve(...args),
  k12InsightReport: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12CreateGradingJob: (...args: unknown[]) => h.createJob(...args),
  k12GetGradingJob: (...args: unknown[]) => h.getJob(...args),
  k12GetGradingJobResult: (...args: unknown[]) => h.getResult(...args),
  k12ConfirmGradingJob: (...args: unknown[]) => h.confirmJob(...args),
  k12RetryGradingJob: (...args: unknown[]) => h.retryJob(...args),
  k12CancelGradingJob: (...args: unknown[]) => h.cancelJob(...args),
  k12ColdStart: (...args: unknown[]) => h.coldStart(...args),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

import { useK12Store } from '../store'

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function job(stage: string, jobId = 'job-unknown') {
  return {
    job_id: jobId,
    submission_id: 'photo-1',
    stage,
    confirmation_state: stage === 'queued' ? 'pending' : 'confirmed',
    anchor_state: 'located',
    deadline: 0,
    idempotency_key: 'desktop|photo-1|v0',
    confirmed_version: 1,
    attempt_count: 1,
    retryable: false,
    version: 1,
    created_at: 1,
    updated_at: 2,
  }
}

function status(stage: string, extra: Record<string, unknown> = {}) {
  return {
    job_id: 'job-unknown',
    stage,
    confirmation_state: 'confirmed',
    anchor_state: 'located',
    deadline: 0,
    confirmed_version: 1,
    job: job(stage),
    ...extra,
  }
}

const questions = [
  {
    problem_id: 'p-1',
    question: '3.8×3=?',
    knowledge_points: ['小数乘法'],
    answer_state: 'present',
    student_answer: '10.4',
  },
  {
    problem_id: 'p-2',
    question: '2x+15=43',
    knowledge_points: ['方程'],
    answer_state: 'blank',
    student_answer: '',
  },
]

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      grade: '五年级上',
      sessionId: 'session-1',
      initialImage: 'data:image/png;base64,AAAA',
      ...props,
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

async function settleLegacyPollIfNeeded(settled: () => boolean) {
  if (settled()) return
  await vi.advanceTimersByTimeAsync(2_501)
  await flushPromises()
}

describe('K12 整卷批改 outcome_unknown（DD-030）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerK12Scenario()
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.cancelJob.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('API 契约把 GradingJob stage 收窄为显式联合类型（包含 outcome_unknown）', () => {
    const block = apiSource.match(/export type GradingJobStage\s*=([\s\S]*?)\n\n/)?.[1] ?? ''
    const actual = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(actual).toEqual([
      'queued',
      'normalizing',
      'recognizing',
      'locating',
      'awaiting_confirmation',
      'assessing',
      'rendering',
      'projecting',
      'completed',
      'cancelled',
      'outcome_unknown',
      'failed_retryable',
      'failed_terminal',
    ])
    expect(apiSource).toMatch(/stage:\s*GradingJobStage/)
  })

  it('store：confirm 后首个 GET 为 outcome_unknown 时立即收敛，零 result/retry/重复 GET', async () => {
    vi.useFakeTimers()
    h.confirmJob.mockResolvedValue(status('assessing'))
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', { confirmation_state: 'pending' }),
      )
      .mockResolvedValueOnce(status('outcome_unknown'))
      // 仅供旧实现退出 2.5 秒轮询，避免 RED 用例遗留长计时器；正确实现不会消费此响应。
      .mockResolvedValueOnce(status('completed'))
    h.getResult.mockResolvedValue({
      job_id: 'job-unknown',
      result: { mode: 'grade', items: [], markdown: '' },
    })

    const store = useK12Store()
    let settled = false
    const resultPromise = store
      .gradePhotoJob('mingming', 'job-unknown', { subject: '数学', grade: '五年级上' })
      .then((value) => {
        settled = true
        return value
      })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    const settledInFirstPoll = settled
    await settleLegacyPollIfNeeded(() => settled)
    const result = await resultPromise

    expect(settledInFirstPoll).toBe(true)
    expect(result).toEqual({ stage: 'outcome_unknown' })
    expect(h.confirmJob).toHaveBeenCalledTimes(1)
    expect(h.getJob).toHaveBeenCalledTimes(2)
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
  })

  it('store：已确认/批改中的同一 Job 只 GET+轮询，严禁重复 confirm', async () => {
    h.getJob
      .mockResolvedValueOnce(status('assessing', { confirmation_state: 'confirmed' }))
      .mockResolvedValueOnce(status('completed', { confirmation_state: 'confirmed' }))
    h.getResult.mockResolvedValue({
      job_id: 'job-unknown',
      result: { mode: 'grade', items: [], markdown: '' },
    })

    await expect(
      useK12Store().gradePhotoJob('mingming', 'job-unknown', {
        subject: '数学',
        grade: '五年级上',
      }),
    ).resolves.toMatchObject({ stage: 'completed' })

    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.getJob).toHaveBeenCalledTimes(2)
    expect(h.getResult).toHaveBeenCalledTimes(1)
  })

  it('常规批改轮询不以 240 次客户端上限猜失败，只认服务端停点或 AbortSignal', async () => {
    vi.useFakeTimers()
    h.confirmJob.mockResolvedValue(status('assessing'))
    h.getJob.mockResolvedValueOnce(
      status('awaiting_confirmation', { confirmation_state: 'pending' }),
    )
    for (let index = 0; index < 240; index += 1) {
      h.getJob.mockResolvedValueOnce(status('assessing'))
    }
    h.getJob.mockResolvedValueOnce(status('outcome_unknown'))

    const grading = useK12Store().gradePhotoJob('mingming', 'job-unknown', {
      subject: '数学',
      grade: '五年级上',
    })
    await vi.advanceTimersByTimeAsync(600_001)
    await expect(grading).resolves.toEqual({ stage: 'outcome_unknown' })

    expect(h.confirmJob).toHaveBeenCalledTimes(1)
    expect(h.getJob).toHaveBeenCalledTimes(242)
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
  })

  it('常规批改轮询响应 AbortSignal，中止后不再 GET/result/retry', async () => {
    vi.useFakeTimers()
    h.confirmJob.mockResolvedValue(status('assessing'))
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', { confirmation_state: 'pending' }),
      )
      .mockResolvedValueOnce(status('assessing'))
      // 只用于错误实现退出等待；正确实现会在 abort 后停止，绝不消费。
      .mockResolvedValueOnce(status('outcome_unknown'))
    const controller = new AbortController()
    let rejection: unknown
    const grading = useK12Store()
      .gradePhotoJob(
        'mingming',
        'job-unknown',
        { subject: '数学', grade: '五年级上' },
        controller.signal,
      )
      .catch((error) => {
        rejection = error
      })

    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    controller.abort()
    await flushPromises()
    const stoppedOnAbort = (rejection as Error | undefined)?.name
    if (!rejection) await vi.advanceTimersByTimeAsync(2_501)
    await grading

    expect(stoppedOnAbort).toBe('AbortError')
    expect(h.confirmJob).toHaveBeenCalledTimes(1)
    expect(h.getJob).toHaveBeenCalledTimes(2)
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
  })

  it('终态 result 请求透传 AbortSignal，避免组件卸载后残留请求', async () => {
    h.confirmJob.mockResolvedValue(status('assessing'))
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', { confirmation_state: 'pending' }),
      )
      .mockResolvedValue(status('completed'))
    h.getResult.mockResolvedValue({
      job_id: 'job-unknown',
      result: { mode: 'grade', items: [], markdown: '' },
    })
    const controller = new AbortController()

    await expect(
      useK12Store().gradePhotoJob(
        'mingming',
        'job-unknown',
        { subject: '数学', grade: '五年级上' },
        controller.signal,
      ),
    ).resolves.toMatchObject({ stage: 'completed' })

    expect(h.getResult).toHaveBeenCalledWith('mingming', 'job-unknown', controller.signal)
  })

  it('组件卸载会中止整卷批改轮询，同时保留持久 Job 供刷新恢复', async () => {
    vi.useFakeTimers()
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('assessing'))
      .mockResolvedValueOnce(status('assessing'))
      // 只用于错误实现退出等待；正确实现卸载后不会消费。
      .mockResolvedValueOnce(status('outcome_unknown'))
    h.confirmJob.mockResolvedValue(status('assessing'))

    const wrapper = mountPanel()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="recognize-grade-all"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(h.getJob).toHaveBeenCalledTimes(3)

    const gradingSignal = h.getJob.mock.calls[2]?.[2] as AbortSignal | undefined
    wrapper.unmount()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2_501)

    expect(gradingSignal).toBeInstanceOf(AbortSignal)
    expect(gradingSignal?.aborted).toBe(true)
    expect(h.getJob).toHaveBeenCalledTimes(3)
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
  })

  it('create 后识别 GET 直接 unknown：一轮停止并原位投影，零 confirm/retry/result', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(status('outcome_unknown'))
      .mockResolvedValueOnce(status('completed'))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('[data-testid="recognize-outcome-unknown"]').text()).toContain('结果待核实')
    expect(h.createJob).toHaveBeenCalledTimes(1)
    expect(h.getJob).toHaveBeenCalledTimes(1)
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.tutoringTips).not.toHaveBeenCalled()
  })

  it('定位 GET 直接 unknown：一轮停止并原位投影，零 confirm/retry/result', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(
        status('outcome_unknown', {
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('completed'))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('[data-testid="recognize-outcome-unknown"]').text()).toContain('结果待核实')
    expect(h.getJob).toHaveBeenCalledTimes(2)
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
    expect(h.tutoringTips).not.toHaveBeenCalled()
  })

  it('定位 unknown 后确认、修正与冷启动入口均为 UI + handler 双门控', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(
        status('outcome_unknown', {
          confirmation_state: 'pending',
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )

    const wrapper = mountPanel({ grade: undefined })
    await flushPromises()

    const confirm = wrapper.get('[data-testid="recognize-confirm-all"]')
    const correct = wrapper.get('[data-testid="recognize-correct"]')
    const coldStart = wrapper.get('[data-testid="coldstart-infer"]')
    for (const control of [confirm, correct, coldStart]) {
      expect(control.attributes('disabled')).toBeDefined()
      // 模拟脚本/竞态绕过 disabled；handler 仍必须 fail-closed。
      control.element.removeAttribute('disabled')
      await control.trigger('click')
    }
    await flushPromises()

    expect(wrapper.find('[data-testid="rq-problem-0"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recognize-batch-actions"]').exists()).toBe(false)
    expect(h.coldStart).not.toHaveBeenCalled()
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
  })

  it('已生成辅导要点在 unknown 后保留；生成型入口冻结，打印与发送仍可用', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          recognition: { questions: [questions[0]], subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('outcome_unknown', { confirmation_state: 'confirmed' }))
    h.confirmJob.mockResolvedValue(status('assessing', { confirmation_state: 'confirmed' }))
    h.tutoringTips.mockResolvedValue({
      knowledge_points: ['小数乘法'],
      sections: [
        { title: '这页在练什么', content: '小数乘法。', source_label: '📖 依据课本' },
        { title: '小明要留意', content: '暂无历史证据。', source_label: '🧠 学情信号' },
        {
          title: '每道题怎么带（不直接给答案）',
          content: '先问孩子小数位数。',
          source_label: '🤖 AI 归纳·供参考',
        },
      ],
    })

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    expect(h.tutoringTips).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="tutoring-tips"]').text()).toContain('这页在练什么')

    await wrapper.get('[data-testid="recognize-grade-all"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="recognize-outcome-unknown"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tutoring-tips"]').text()).toContain('这页在练什么')
    expect(h.tutoringTips).toHaveBeenCalledTimes(1)
    expect(
      wrapper.get('[data-testid="tutoring-tips-grounding-open"]').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.get('[data-testid="tutoring-tips-print"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="tutoring-tips-send"]').attributes('disabled')).toBeUndefined()
  })

  it('unknown 后失败态重试为 UI + handler 双门控', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          recognition: { questions: [questions[0]], subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('outcome_unknown', { confirmation_state: 'confirmed' }))
    h.confirmJob.mockResolvedValue(status('assessing', { confirmation_state: 'confirmed' }))
    h.tutoringTips.mockRejectedValue(new Error('provider timeout'))

    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="recognize-grade-all"]').trigger('click')
    await flushPromises()

    const retry = wrapper.get('[data-testid="tutoring-tips-retry"]')
    expect(retry.attributes('disabled')).toBeDefined()
    retry.element.removeAttribute('disabled')
    await retry.trigger('click')
    await flushPromises()
    expect(h.tutoringTips).toHaveBeenCalledTimes(1)
  })

  it('定位轮询不以 240 次客户端上限猜失败，只认服务端停点或 AbortSignal', async () => {
    vi.useFakeTimers()
    for (let index = 0; index < 240; index += 1) {
      h.getJob.mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
    }
    h.getJob.mockResolvedValueOnce(
      status('outcome_unknown', {
        anchor_state: 'pending',
        recognition: { questions, subject: '数学' },
      }),
    )

    const locating = useK12Store().waitForPhotoJobAnchor('mingming', 'job-unknown')
    await vi.advanceTimersByTimeAsync(600_001)
    await expect(locating).resolves.toMatchObject({ stage: 'outcome_unknown' })

    expect(h.getJob).toHaveBeenCalledTimes(241)
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
  })

  it('原位卡逐字对齐原型；所有单题/整卷 grade/solve 入口均 UI + handler 双门控', async () => {
    vi.useFakeTimers()
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('outcome_unknown'))
      // 仅供旧实现退出轮询；正确实现不会消费。
      .mockResolvedValueOnce(status('completed'))
    h.confirmJob.mockResolvedValue(status('assessing'))
    h.getResult.mockResolvedValue({
      job_id: 'job-unknown',
      result: { mode: 'grade', items: [], markdown: '' },
    })

    const wrapper = mountPanel()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    await wrapper.get('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="recognize-grade-all"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    const cardAppearedInFirstPoll = wrapper
      .find('[data-testid="recognize-outcome-unknown"]')
      .exists()
    const processingStoppedInFirstPoll = !wrapper.text().includes('整卷处理中')
    await settleLegacyPollIfNeeded(() => !wrapper.text().includes('整卷处理中'))

    expect(cardAppearedInFirstPoll).toBe(true)
    expect(processingStoppedInFirstPoll).toBe(true)
    const card = wrapper.get('[data-testid="recognize-outcome-unknown"]')
    expect(card.text()).toContain('结果待核实')
    expect(card.text()).toContain(
      '本次批改结果尚未确认。为避免重复调用，系统不会自动重试；刷新或重新打开后仍会保留此状态。',
    )
    expect(card.text()).toContain('查看结果状态')
    expect(card.text()).not.toContain('重试当前阶段')

    const modelButtons = [
      '[data-testid="rq-grade-0"]',
      '[data-testid="rq-solve-1"]',
      '[data-testid="recognize-grade-all"]',
      '[data-testid="recognize-solve-all"]',
    ]
    for (const selector of modelButtons) {
      expect(wrapper.get(selector).attributes('disabled')).toBeDefined()
    }

    const before = {
      grade: h.grade.mock.calls.length,
      solve: h.solve.mock.calls.length,
      confirm: h.confirmJob.mock.calls.length,
    }
    // 模拟脚本/竞态绕过 disabled 属性，handler 仍必须 fail-closed。
    for (const selector of modelButtons) {
      wrapper.get(selector).element.removeAttribute('disabled')
      await wrapper.get(selector).trigger('click')
    }
    await flushPromises()
    expect(h.grade).toHaveBeenCalledTimes(before.grade)
    expect(h.solve).toHaveBeenCalledTimes(before.solve)
    expect(h.confirmJob).toHaveBeenCalledTimes(before.confirm)
    expect(h.retryJob).not.toHaveBeenCalled()
  })

  it('详情只读：逐字对齐原型、打开零网络、焦点圈定、Esc 关闭并回到触发按钮', async () => {
    h.getJob.mockResolvedValue(status('outcome_unknown'))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    const wrapper = mountPanel({ initialImage: undefined })
    await flushPromises()

    const trigger = wrapper.get('[data-testid="recognize-outcome-status"]')
    const callsBeforeOpen = {
      create: h.createJob.mock.calls.length,
      get: h.getJob.mock.calls.length,
      result: h.getResult.mock.calls.length,
      retry: h.retryJob.mock.calls.length,
      confirm: h.confirmJob.mock.calls.length,
    }
    ;(trigger.element as HTMLElement).focus()
    await trigger.trigger('click')
    await flushPromises()

    const dialog = document.querySelector<HTMLElement>('[data-testid="recognize-outcome-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.textContent).toContain('结果待核实')
    expect(dialog?.textContent).toContain('本次批改没有得到可确认的完整结果。')
    expect(dialog?.textContent).toContain(
      '为避免重复调用和重复计费，系统不会自动重试。已完成的内容会安全保留；你可以稍后再查看，刷新或重新打开后仍会恢复这个状态。',
    )
    expect(dialog?.textContent).not.toMatch(/outcome_unknown|invocation|ledger|checkpoint|调用 ID/i)
    const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent?.trim()).toBe('关闭')
    expect({
      create: h.createJob.mock.calls.length,
      get: h.getJob.mock.calls.length,
      result: h.getResult.mock.calls.length,
      retry: h.retryJob.mock.calls.length,
      confirm: h.confirmJob.mock.calls.length,
    }).toEqual(callsBeforeOpen)

    buttons[0]?.focus()
    buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-testid="recognize-outcome-dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })

  it('创建 Job 透传 source_session，并只持久化 session→agent+job 最小绑定', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob.mockResolvedValue(
      status('awaiting_confirmation', {
        confirmation_state: 'pending',
        recognition: { questions, subject: '数学' },
      }),
    )

    const store = useK12Store()
    await store.recognizePhotoJob(
      'mingming',
      'data:image/png;base64,SECRET_IMAGE_BYTES',
      undefined,
      'session-1',
    )

    expect(h.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ source_session: 'session-1' }),
      undefined,
    )
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(raw).not.toMatch(/SECRET_IMAGE_BYTES|image|base64|result/i)
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
    })
  })

  it('create 成功后立即 abort 仍保留最小绑定，供刷新恢复同一 Job', async () => {
    const controller = new AbortController()
    h.createJob.mockImplementation(async () => {
      controller.abort()
      return { created: true, job: job('queued') }
    })

    await expect(
      useK12Store().recognizePhotoJob(
        'mingming',
        'data:image/png;base64,SECRET_IMAGE_BYTES',
        controller.signal,
        'session-1',
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(h.getJob).not.toHaveBeenCalled()
    expect(h.cancelJob).toHaveBeenCalledWith('mingming', 'job-unknown')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      version: 1,
      bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
    })
  })

  it('刷新恢复只 GET 同一 session+agent 的 Job；跨孩子绑定 fail-closed', async () => {
    h.getJob.mockResolvedValue(status('outcome_unknown'))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )

    const wrapper = mountPanel({ initialImage: undefined })
    await flushPromises()
    expect(h.getJob).toHaveBeenCalledTimes(1)
    expect(h.getJob).toHaveBeenCalledWith('mingming', 'job-unknown', expect.any(AbortSignal))
    expect(wrapper.get('[data-testid="recognize-outcome-unknown"]').text()).toContain('结果待核实')
    expect(h.createJob).not.toHaveBeenCalled()
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()

    wrapper.unmount()
    h.getJob.mockClear()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'other-child', job_id: 'job-other' } },
      }),
    )
    const other = mountPanel({ initialImage: undefined })
    await flushPromises()
    expect(h.getJob).not.toHaveBeenCalled()
    expect(other.find('[data-testid="recognize-outcome-unknown"]').exists()).toBe(false)
  })

  it('恢复中的活动 Job 只继续 GET 同一 job 直到 unknown，禁止 create/confirm/retry/result', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    h.getJob
      .mockResolvedValueOnce(status('assessing'))
      .mockResolvedValueOnce(status('outcome_unknown'))

    const store = useK12Store()
    let settled = false
    const restoring = store.restorePhotoJob('mingming', 'session-1').then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(settled, 'assessing 不得被静默当作已恢复完成并关闭 UI').toBe(false)
    await vi.advanceTimersByTimeAsync(2_501)
    const restored = await restoring

    expect(restored?.stage).toBe('outcome_unknown')
    expect(h.getJob).toHaveBeenCalledTimes(2)
    expect(h.createJob).not.toHaveBeenCalled()
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('恢复不以客户端固定十分钟上限猜测服务端终态', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    for (let index = 0; index < 240; index += 1) {
      h.getJob.mockResolvedValueOnce(status('assessing'))
    }
    h.getJob.mockResolvedValueOnce(status('outcome_unknown'))

    const restoring = useK12Store().restorePhotoJob('mingming', 'session-1')
    await vi.advanceTimersByTimeAsync(600_001)
    await expect(restoring).resolves.toMatchObject({ stage: 'outcome_unknown' })
    expect(h.getJob).toHaveBeenCalledTimes(241)
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('组件恢复活动批改时沿用既有处理态，随后在首个 unknown 原位收敛', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    h.getJob
      .mockResolvedValueOnce(
        status('assessing', {
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(status('outcome_unknown'))

    const wrapper = mountPanel({ initialImage: undefined })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('整卷处理中')
    expect(wrapper.find('[data-testid="recognize-outcome-unknown"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(2_501)
    await flushPromises()
    expect(wrapper.get('[data-testid="recognize-outcome-unknown"]').text()).toContain('结果待核实')
    expect(wrapper.text()).not.toContain('整卷处理中')
    expect(h.createJob).not.toHaveBeenCalled()
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
  })

  it('组件恢复到 awaiting_confirmation 时回显既有识别结果，不关闭或创建新任务', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    h.getJob.mockResolvedValue(
      status('awaiting_confirmation', {
        confirmation_state: 'pending',
        recognition: { questions, subject: '数学' },
      }),
    )

    const wrapper = mountPanel({ initialImage: undefined })
    await flushPromises()

    expect(wrapper.findAll('[data-testid="rq-item"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="recognize-confirm-all"]').exists()).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(h.createJob).not.toHaveBeenCalled()
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
  })

  it('恢复 awaiting_confirmation + anchor pending 后继续只读 GET 同一 Job 直到 unknown', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    h.getJob
      .mockResolvedValueOnce(
        status('awaiting_confirmation', {
          confirmation_state: 'pending',
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )
      .mockResolvedValueOnce(
        status('outcome_unknown', {
          confirmation_state: 'pending',
          anchor_state: 'pending',
          recognition: { questions, subject: '数学' },
        }),
      )

    const wrapper = mountPanel({ initialImage: undefined })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(wrapper.text()).toContain('正在定位原图题目')
    expect(wrapper.find('[data-testid="recognize-outcome-unknown"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(2_501)
    await flushPromises()
    expect(wrapper.get('[data-testid="recognize-outcome-unknown"]').text()).toContain('结果待核实')
    expect(h.getJob).toHaveBeenCalledTimes(2)
    expect(h.getJob).toHaveBeenNthCalledWith(1, 'mingming', 'job-unknown', expect.any(AbortSignal))
    expect(h.getJob).toHaveBeenNthCalledWith(2, 'mingming', 'job-unknown', expect.any(AbortSignal))
    expect(h.createJob).not.toHaveBeenCalled()
    expect(h.confirmJob).not.toHaveBeenCalled()
    expect(h.retryJob).not.toHaveBeenCalled()
    expect(h.getResult).not.toHaveBeenCalled()
  })

  it('组件卸载会中止活动恢复轮询，不留下后台 GET', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    h.getJob.mockResolvedValue(status('assessing'))

    const wrapper = mountPanel({ initialImage: undefined })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(h.getJob).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5_001)
    await flushPromises()
    expect(h.getJob).toHaveBeenCalledTimes(1)
  })

  it.each(['completed', 'cancelled', 'failed_terminal', 'failed_retryable'])(
    '恢复遇到不再支持投影的确定状态 %s 时清理 binding，避免刷新幽灵卡',
    async (stage) => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
        }),
      )
      h.getJob.mockResolvedValue(status(stage))
      const restored = await useK12Store().restorePhotoJob('mingming', 'session-1')
      expect(restored).toBeNull()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    },
  )

  it.each(['{bad json', JSON.stringify({ version: 2, bindings: {} })])(
    '损坏或未知版本 binding fail-closed 并清理：%s',
    async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw)
      const restored = await useK12Store().restorePhotoJob('mingming', 'session-1')
      expect(restored).toBeNull()
      expect(h.getJob).not.toHaveBeenCalled()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    },
  )

  it('空 session 不持久化；恢复 GET 404 时清理同一 binding', async () => {
    h.createJob.mockResolvedValue({ created: true, job: job('queued') })
    h.getJob.mockResolvedValueOnce(
      status('awaiting_confirmation', {
        confirmation_state: 'pending',
        recognition: { questions, subject: '数学' },
      }),
    )
    const store = useK12Store()
    await store.recognizePhotoJob('mingming', 'data:image/png;base64,AAAA')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    h.getJob.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    await expect(store.restorePhotoJob('mingming', 'session-1')).resolves.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
