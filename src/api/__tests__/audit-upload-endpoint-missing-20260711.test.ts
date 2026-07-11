/**
 * hex-test 审计 · 契约#9：上传端点缺失检测在 fetch 路径 miss。
 * uploadFormData 在 !ok 时 throw new Error(apiErr.message) —— 只带 message 丢了 status，
 * 非 JSON 404 的 message="Not Found" 又不匹配 isKnowledgeUploadEndpointMissing 的任何关键词/
 * 状态条件 → 检测 miss → 用户看到裸 "Not Found" 而非友好的"上传不可用"提示。
 * RED：fetch 路径 404 抛裸串 → FAIL；GREEN：uploadFormData throw 保留 status → 检出。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { uploadDocument } from '@/api/knowledge'
import { KNOWLEDGE_UPLOAD_UNAVAILABLE_MESSAGE } from '@/config/knowledge-errors'

describe('hex-test 契约#9 · 上传缺失检测 fetch 路径', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        clone: () => ({ json: () => Promise.reject(new Error('not json')) }),
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('Not Found'),
      } as unknown as Response),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fetch 路径(无 onProgress) 遇缺失端点 404 应识别为端点缺失并抛友好提示', async () => {
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    // 无 onProgress → apiPost(FormData) → uploadFormData(fetch)；缺失端点应被识别
    await expect(uploadDocument(file)).rejects.toThrow(KNOWLEDGE_UPLOAD_UNAVAILABLE_MESSAGE)
  })
})
