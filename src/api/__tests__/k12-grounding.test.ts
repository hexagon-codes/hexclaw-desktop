import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import { k12AddGrounding } from '../k12'

describe('K12 教材 grounding API 契约', () => {
  beforeEach(() => apiPost.mockReset())

  it('按 agent scope 上传教材原文并透传取消信号', async () => {
    const signal = new AbortController().signal
    const req = { agent: 'mingming', title: '人教版五上.pdf', content: '小数乘法教材原文' }
    apiPost.mockResolvedValue({ ok: true })

    await expect(k12AddGrounding(req, signal)).resolves.toEqual({ ok: true })
    expect(apiPost).toHaveBeenCalledWith('/api/k12/grounding', req, { signal })
  })
})
