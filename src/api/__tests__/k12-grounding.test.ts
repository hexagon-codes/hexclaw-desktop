import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import { k12TutoringTips } from '../k12'

describe('K12 辅导要点 API 契约', () => {
  beforeEach(() => apiPost.mockReset())

  it('辅导要点请求只透传当前已确认 Job，不接受客户端学科或知识点', async () => {
    const signal = new AbortController().signal
    const req = {
      agent: 'mingming',
      dispatch_id: 'dispatch-confirmed-1',
    }
    apiPost.mockResolvedValue({
      knowledge_points: ['小数乘法'],
      sections: [
        { title: '这页在练什么', content: '小数乘法。', source_label: '📖 依据课本' },
        { title: '孩子要留意', content: '暂无历史证据。', source_label: '🧠 学情信号' },
        {
          title: '每道题怎么带（不直接给答案）',
          content: '先问孩子小数位数。',
          source_label: '🤖 AI 归纳·供参考',
        },
      ],
    })

    await k12TutoringTips(req, signal)

    expect(apiPost).toHaveBeenCalledWith('/api/k12/tutoring-tips', req, {
      timeout: 120_000,
      signal,
    })
  })
})
