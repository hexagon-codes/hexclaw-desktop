import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import { k12AddGrounding, k12PrepCard } from '../k12'

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

  it('辅导要点请求透传当前学科，不回退到跨学科教材检索', async () => {
    const signal = new AbortController().signal
    const req = {
      agent: 'mingming',
      grade: '五年级上',
      subject: '数学',
      knowledge_points: ['小数乘法'],
    }
    apiPost.mockResolvedValue({ knowledge_points: req.knowledge_points, sections: [] })

    await k12PrepCard(req, signal)

    expect(apiPost).toHaveBeenCalledWith('/api/k12/prep-card', req, {
      timeout: 120_000,
      signal,
    })
  })
})
