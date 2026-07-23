import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import { k12AddGrounding, k12TutoringTips } from '../k12'

describe('K12 教材 grounding API 契约', () => {
  beforeEach(() => apiPost.mockReset())

  it('按 agent scope 上传教材原文并透传取消信号', async () => {
    const signal = new AbortController().signal
    const req = {
      agent: 'mingming',
      subject: '数学',
      title: '人教版五上.pdf',
      content: '小数乘法教材原文',
    }
    apiPost.mockResolvedValue({ ok: true })

    await expect(k12AddGrounding(req, signal)).resolves.toEqual({ ok: true })
    expect(apiPost).toHaveBeenCalledWith('/api/k12/grounding', req, { signal })
  })

  it('辅导要点请求只透传当前已确认 Job，不接受客户端学科或知识点', async () => {
    const signal = new AbortController().signal
    const req = {
      agent: 'mingming',
      grading_job_id: 'job-confirmed-1',
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
