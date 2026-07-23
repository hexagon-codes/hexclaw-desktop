import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => ({
  createJobSpy: vi.fn(),
  getJobSpy: vi.fn(),
  confirmJobSpy: vi.fn(),
  retryJobSpy: vi.fn(),
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
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12CreateGradingJob: (r: unknown) => h.createJobSpy(r),
  k12GetGradingJob: (...args: unknown[]) => h.getJobSpy(...args),
  k12ConfirmGradingJob: (...args: unknown[]) => h.confirmJobSpy(...args),
  k12RetryGradingJob: (...args: unknown[]) => h.retryJobSpy(...args),
  k12TutorTurn: (r: unknown) => h.tutorTurnSpy(r),
  k12BindIM: (r: unknown) => h.bindSpy(r),
  k12ProvisionCron: (r: unknown) => h.provisionSpy(r),
}))

import { useK12Store } from '../store'

describe('K12 store · 自动化/入站接线', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(h).forEach((s) => s.mockReset())
  })

  it('recognizePhotoJob：创建 Job → 轮询到确认停点，回传题目清单 + 整卷学科（桌面入口迁移 §6.7）', async () => {
    h.createJobSpy.mockResolvedValue({
      created: true,
      job: { job_id: 'job-1', stage: 'queued', retryable: false },
    })
    h.getJobSpy.mockResolvedValue({
      job_id: 'job-1',
      stage: 'awaiting_confirmation',
      confirmation_state: 'pending',
      anchor_state: 'located',
      job: { job_id: 'job-1', stage: 'awaiting_confirmation' },
      recognition: { questions: [{ question: '3.8×3', knowledge_points: ['小数乘法'] }], subject: '数学' },
    })
    const store = useK12Store()
    const res = await store.recognizePhotoJob('mingming', 'data:image/png;base64,AAAA')
    const createReq = h.createJobSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(createReq.agent).toBe('mingming')
    expect(createReq.image_base64).toBe('data:image/png;base64,AAAA')
    expect(createReq.source_kind).toBe('desktop')
    // §4.10 统一幂等键：同（agent, 照片）派生稳定 source_key，同图重投命中同一 Job。
    expect(createReq.source_key).toBeTruthy()
    expect(res.jobId).toBe('job-1')
    expect(res.questions[0]?.question).toBe('3.8×3')
    // Polish-2：整卷学科随停点识别产物回传（供护栏预填学科下拉）
    expect(res.subject).toBe('数学')
    expect(res.anchorState).toBe('located')
    // 未命中失败 Job：不触发 retry
    expect(h.retryJobSpy).not.toHaveBeenCalled()
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
