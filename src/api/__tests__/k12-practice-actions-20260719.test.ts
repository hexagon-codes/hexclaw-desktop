import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: (...args: unknown[]) => h.apiGet(...args),
  apiPost: (...args: unknown[]) => h.apiPost(...args),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://127.0.0.1:8787' } }))

import {
  k12FillPracticeBasket,
  k12GenerateCustomPaper,
  k12GetMistakePracticeGeneration,
  k12RetryMistakePracticeGeneration,
  k12StartMistakePracticeGeneration,
  k12SubmitPracticeSet,
  k12GradePracticeSet,
} from '../k12'

describe('K12 练习集动作 API · 禁止空回传/空复批旁路', () => {
  beforeEach(() => {
    h.apiGet.mockReset().mockResolvedValue({})
    h.apiPost.mockReset().mockResolvedValue({})
  })

  it('逐题加入练习集使用服务端持久化任务，不再调用旧 review/retry 两阶段链路', async () => {
    const request = {
      agent: 'ming ming',
      record_id: 'mistake/1',
      idempotency_key: 'desktop-single-practice-1',
      grade: '五年级下',
      textbook: '人教版',
      difficulty: 'same' as const,
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
    }
    await k12StartMistakePracticeGeneration(request)
    expect(h.apiPost).toHaveBeenCalledWith(
      '/api/k12/mistakes/mistake%2F1/practice-generation',
      {
        agent: 'ming ming',
        idempotency_key: 'desktop-single-practice-1',
        grade: '五年级下',
        textbook: '人教版',
        difficulty: 'same',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      },
    )

    await k12GetMistakePracticeGeneration('ming ming', 'mistake/1')
    expect(h.apiGet).toHaveBeenCalledWith(
      '/api/k12/mistakes/mistake%2F1/practice-generation',
      { agent: 'ming ming' },
    )

    await k12RetryMistakePracticeGeneration('ming ming', 'mistake/1')
    expect(h.apiPost).toHaveBeenLastCalledWith(
      '/api/k12/mistakes/mistake%2F1/practice-generation/retry',
      { agent: 'ming ming' },
    )
  })

  it('逐题生成显式模型路由必须成对冻结，禁止界面模型与实际任务漂移', () => {
    expect(() =>
      k12StartMistakePracticeGeneration({
        agent: 'mingming',
        record_id: 'mistake-1',
        idempotency_key: 'desktop-single-practice-invalid-route',
        textbook: '人教版',
        provider: 'hexclaw-gpt',
      }),
    ).toThrow('逐题出题模型路由必须同时包含供应商和模型')
  })

  it('手动生成复习卷复用后端 fill-basket 验证装篮链', async () => {
    await k12FillPracticeBasket('ming ming')
    expect(h.apiPost).toHaveBeenCalledWith('/api/k12/cron/fill-basket?agent=ming%20ming', {})
  })

  it('DD-027：自定义组卷只提交一次冻结参数给正式 command', async () => {
    await k12GenerateCustomPaper({
      agent: 'mingming',
      idempotency_key: 'desktop-paper-1',
      scope: 'unmastered',
      total: 5,
      per_source: 2,
      difficulty: 'harder',
      textbook: '人教版',
      grade: '五年级上',
      source_session: 'session-1',
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
    })

    expect(h.apiPost).toHaveBeenCalledTimes(1)
    expect(h.apiPost).toHaveBeenCalledWith('/api/k12/practice-sets/custom-paper', {
      agent: 'mingming',
      idempotency_key: 'desktop-paper-1',
      scope: 'unmastered',
      total: 5,
      per_source: 2,
      difficulty: 'harder',
      textbook: '人教版',
      grade: '五年级上',
      source_session: 'session-1',
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
    })
  })

  it('DD-027：显式模型路由必须成对提交，禁止界面模型与实际任务漂移', () => {
    expect(() =>
      k12GenerateCustomPaper({
        agent: 'mingming',
        idempotency_key: 'desktop-paper-route-invalid',
        scope: 'week',
        total: 5,
        per_source: 1,
        difficulty: 'same',
        textbook: '人教版',
        provider: 'hexclaw-gpt',
      }),
    ).toThrow('组卷模型路由必须同时包含供应商和模型')
  })

  it('DD-028：回传携带幂等 return_id、照片资产和明确覆盖题；任一为空都在客户端阻断', async () => {
    await k12SubmitPracticeSet('mingming', 'ps-1', {
      return_id: 'return-1', item_ids: ['q1'], asset_id: 'asset://mingming/a.png',
    })
    expect(h.apiPost).toHaveBeenCalledWith('/api/k12/practice-sets/ps-1/submit', {
      agent: 'mingming', return_id: 'return-1', item_ids: ['q1'], asset_id: 'asset://mingming/a.png',
    })
    expect(() => k12SubmitPracticeSet('mingming', 'ps-1', {
      return_id: '', item_ids: ['q1'], asset_id: 'asset://mingming/a.png',
    })).toThrow()
    expect(() => k12SubmitPracticeSet('mingming', 'ps-1', {
      return_id: 'return-2', item_ids: [], asset_id: 'asset://mingming/a.png',
    })).toThrow()
    expect(() => k12SubmitPracticeSet('mingming', 'ps-1', {
      return_id: 'return-2', item_ids: ['q1'], asset_id: '',
    })).toThrow()
  })

  it('复批只发送非空逐题 results；空数组不能触发旧“整卷全通过”语义', async () => {
    await k12GradePracticeSet('mingming', 'ps-1', [{ item_id: 'q1', correct: false }])
    expect(h.apiPost).toHaveBeenCalledWith('/api/k12/practice-sets/ps-1/grade', {
      agent: 'mingming', results: [{ item_id: 'q1', correct: false }],
    })
    expect(() => k12GradePracticeSet('mingming', 'ps-1', [])).toThrow('请逐题记录对或错')
  })
})
