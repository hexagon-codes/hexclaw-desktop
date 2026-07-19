/**
 * BUG-20260718 · 组A-2 · knowledge.getDocumentContent 把故障伪装成"空文档"
 *
 * §15 红灯：detail/search 都失败后返回空串，无法区分「真实空文档」与「取内容故障」。
 * 修复：两条取内容路径都因错误失败（而非确有空文档）时抛错，让 UI 区分"故障"与"空"。
 * 至少一条路径成功但内容确为空 → 仍返回 ''（真实空文档）。
 *
 * 关联门：PLATAPI-044/049、KNOW-002/010/027、UICLICK-012
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiGet, apiPost, apiDelete, apiPut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))
vi.mock('../client', () => ({ apiGet, apiPost, apiDelete, apiPut }))
vi.mock('@/config/env', () => ({ OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:16060' } }))
vi.mock('@/utils/errors', () => ({
  fromHttpStatus: vi.fn((s: number) => ({ message: `HTTP ${s}` })),
  fromNativeError: vi.fn((e: unknown) => ({ status: 500, message: String(e) })),
}))

import { getDocumentContent } from '../knowledge'

const doc = { id: 'd1', title: 'Test', chunk_count: 2, created_at: '' }

describe('BUG-20260718 getDocumentContent 故障 vs 空文档', () => {
  beforeEach(() => vi.clearAllMocks())

  it('[bug] detail 与 search 都失败时抛错（不伪装成空串）', async () => {
    apiGet.mockRejectedValueOnce(new Error('500'))
    apiPost.mockRejectedValueOnce(new Error('500'))
    await expect(getDocumentContent(doc)).rejects.toThrow()
  })

  it('确有空文档（detail 空 + search 无命中，均成功）时返回空串', async () => {
    apiGet.mockResolvedValueOnce({ id: 'd1', title: 'Test', content: '' })
    apiPost.mockResolvedValueOnce({ result: [] })
    await expect(getDocumentContent(doc)).resolves.toBe('')
  })
})
