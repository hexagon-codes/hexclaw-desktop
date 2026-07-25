import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => ({
  uploadSpy: vi.fn(),
  createTaskSpy: vi.fn(),
  getTaskSpy: vi.fn(),
  getResultSpy: vi.fn(),
  confirmTaskSpy: vi.fn(),
  retryTaskSpy: vi.fn(),
  cancelTaskSpy: vi.fn(),
  tutorTurnSpy: vi.fn(),
  bindSpy: vi.fn(),
  provisionSpy: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  // store 顶部 import 的其余符号在本用例不触发，给足空实现即可。
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12UploadAsset: (...args: unknown[]) => h.uploadSpy(...args),
  k12CreateImageTask: (...args: unknown[]) => h.createTaskSpy(...args),
  k12GetImageTask: (...args: unknown[]) => h.getTaskSpy(...args),
  k12GetImageTaskResult: (...args: unknown[]) => h.getResultSpy(...args),
  k12ConfirmImageTask: (...args: unknown[]) => h.confirmTaskSpy(...args),
  k12RetryImageTask: (...args: unknown[]) => h.retryTaskSpy(...args),
  k12CancelImageTask: (...args: unknown[]) => h.cancelTaskSpy(...args),
  k12TutorTurn: (r: unknown) => h.tutorTurnSpy(r),
  k12BindIM: (r: unknown) => h.bindSpy(r),
  k12ProvisionCron: (r: unknown) => h.provisionSpy(r),
}))

import { useK12Store } from '../store'

function imageTaskResponse(
  overrides: Record<string, unknown> = {},
  projectionOverrides: Record<string, unknown> = {},
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
        stage: 'awaiting_confirmation',
        confirmation_state: 'pending',
        anchor_state: 'located',
        recognition: {
          questions: [
            {
              question: '3.8×3',
              knowledge_points: ['小数乘法'],
              answer_state: 'blank',
              confirmation_required: true,
            },
          ],
          subject: '数学',
        },
        ...projectionOverrides,
      },
      progress: { operation: 'homework', state: 'awaiting_confirmation' },
      version: 1,
      created_at: 1,
      updated_at: 1,
      ...overrides,
    },
  }
}

describe('K12 store · 自动化/入站接线', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    Object.values(h).forEach((s) => s.mockReset())
    h.uploadSpy.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
  })

  it('dispatchImageTask：固化图片 → 创建 facade → 轮询到确认停点并回传公开投影', async () => {
    h.createTaskSpy.mockResolvedValue({
      created: true,
      ...imageTaskResponse(
        { status: 'routing', target: undefined, target_projection: undefined },
        {},
      ),
    })
    h.getTaskSpy.mockResolvedValue(imageTaskResponse())
    const store = useK12Store()
    const res = await store.dispatchImageTask({
      agent: 'mingming',
      dataUrl: 'data:image/png;base64,AAAA',
      sourceSession: 'session-basic',
      sourceRef: 'message-basic',
    })
    const createReq = h.createTaskSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(createReq.agent).toBe('mingming')
    expect(createReq.source_kind).toBe('desktop')
    expect(createReq.source_ref).toBe('message-basic')
    expect(createReq.source_session).toBe('session-basic')
    expect(createReq.source_asset_refs).toEqual(['asset://mingming/photo.png'])
    expect(createReq.route_request).toEqual({ selection_source: 'auto' })
    expect(res.dispatchId).toBe('dispatch-1')
    expect(res.questions[0]?.question).toBe('3.8×3')
    expect(res.subject).toBe('数学')
    expect(res.anchorState).toBe('located')
    expect(h.retryTaskSpy).not.toHaveBeenCalled()
  })

  it('显式视觉路由进入 route_request；两次提交由各自 source_ref 隔离', async () => {
    h.createTaskSpy.mockResolvedValue({ created: true, ...imageTaskResponse() })
    const store = useK12Store()
    const route = {
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      capability: 'vision' as const,
    }

    await store.dispatchImageTask({
      agent: 'mingming',
      dataUrl: 'data:image/png;base64,AAAA',
      sourceSession: 'scenario-session',
      route,
      sourceRef: 'message-sol',
    })

    const createReq = h.createTaskSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(createReq.route_request).toEqual({
      provider: route.provider,
      model: route.model,
      selection_source: 'explicit',
    })
    expect(createReq.source_session).toBe('scenario-session')
    expect(createReq.source_ref).toBe('message-sol')

    h.createTaskSpy.mockClear()
    await store.dispatchImageTask({
      agent: 'mingming',
      dataUrl: 'data:image/png;base64,AAAA',
      sourceSession: 'scenario-session',
      route: { ...route, model: 'gpt-5.3-codex-spark' },
      sourceRef: 'message-spark',
    })
    const otherRouteReq = h.createTaskSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(otherRouteReq.source_ref).not.toBe(createReq.source_ref)
  })

  it('desktop source_ref 是任务幂等身份：同请求重放稳定、同图新提交不复用旧任务', async () => {
    h.createTaskSpy.mockResolvedValue({ created: true, ...imageTaskResponse() })
    const store = useK12Store()
    const route = {
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      capability: 'vision' as const,
    }

    for (const sourceRef of ['message-request-a', 'message-request-a', 'message-request-b']) {
      await store.dispatchImageTask({
        agent: 'mingming',
        dataUrl: 'data:image/png;base64,AAAA',
        sourceSession: 'scenario-session',
        route,
        sourceRef,
      })
    }
    const firstKey = (h.createTaskSpy.mock.calls[0]![0] as { source_ref: string }).source_ref
    const replayKey = (h.createTaskSpy.mock.calls[1]![0] as { source_ref: string }).source_ref
    const newSubmissionKey = (h.createTaskSpy.mock.calls[2]![0] as { source_ref: string }).source_ref

    expect(firstKey).toBe('message-request-a')
    expect(replayKey).toBe(firstKey)
    expect(newSubmissionKey).toBe('message-request-b')
    expect(newSubmissionKey).not.toBe(firstKey)
  })

  it('缺少 desktop session/source identity 时 fail-closed，不再退回图片内容哈希身份', async () => {
    const store = useK12Store()
    await expect(
      store.dispatchImageTask({
        agent: 'mingming',
        dataUrl: 'data:image/png;base64,AAAA',
        sourceSession: '',
        sourceRef: '',
      }),
    ).rejects.toThrow('desktop image task identity')
    expect(h.createTaskSpy).not.toHaveBeenCalled()
  })

  it('tutorTurn 透传分阶段响应', async () => {
    h.tutorTurnSpy.mockResolvedValue({ stage: 3, comfort: false, escalated: true, prompt_hint: 'x', solution: '解：11.4' })
    const store = useK12Store()
    const resp = await store.tutorTurn({ agent: 'mingming', prior_stage: 2, parent_message: '直接讲吧' })
    expect(resp.stage).toBe(3)
    expect(resp.solution).toBe('解：11.4')
  })

  it('setupAutomation：有群则先绑定再注册', async () => {
    h.bindSpy.mockResolvedValue({ bound: true })
    h.provisionSpy.mockResolvedValue({ provisioned: [{ kind: 'weekly-sheet', name: '错题卷', schedule: '0 19 * * 5', job_id: 'j1' }] })
    const store = useK12Store()
    const jobs = await store.setupAutomation('mingming', { platform: 'dingtalk', chatId: 'g1', deliver: ['dingtalk'] })
    expect(h.bindSpy).toHaveBeenCalledWith({ agent: 'mingming', platform: 'dingtalk', chat_id: 'g1' })
    expect(h.provisionSpy).toHaveBeenCalledOnce()
    expect(jobs).toHaveLength(1)
  })

  it('setupAutomation：无群跳过绑定，只注册桌面投递', async () => {
    h.provisionSpy.mockResolvedValue({ provisioned: [] })
    const store = useK12Store()
    await store.setupAutomation('mingming')
    expect(h.bindSpy).not.toHaveBeenCalled()
    expect(h.provisionSpy).toHaveBeenCalledOnce()
  })

  it('setupAutomation：后端 501（未注入 cron）静默降级为空，不抛错', async () => {
    h.provisionSpy.mockRejectedValue(new Error('cron registrar 未注入'))
    const store = useK12Store()
    const jobs = await store.setupAutomation('mingming')
    expect(jobs).toEqual([])
  })
})
