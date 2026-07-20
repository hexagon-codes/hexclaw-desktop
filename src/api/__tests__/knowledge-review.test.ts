import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPost, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => ({
  apiGet,
  apiPost,
  apiDelete,
}))

describe('Knowledge API upload behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uploads to the canonical knowledge upload endpoint', async () => {
    apiPost.mockResolvedValueOnce({
      document_id: 'doc-1',
      job_id: 'job-1',
      text_index_state: 'pending',
      vector_index_state: 'pending',
    })

    const { uploadDocument } = await import('../knowledge')
    const file = new File(['alpha'], 'alpha.pdf', { type: 'application/pdf' })
    const result = await uploadDocument(file)

    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents?user_id=desktop-user',
      expect.any(FormData),
      expect.objectContaining({
        headers: { 'Idempotency-Key': expect.stringMatching(/^knowledge-upload:/) },
        timeout: false,
      }),
    )
    expect(result.document_id).toBe('doc-1')
  })

  it('reports knowledge-disabled when endpoint returns 404', async () => {
    apiPost.mockRejectedValueOnce(new Error('请求的资源不存在'))

    const { uploadDocument } = await import('../knowledge')
    const file = new File(['alpha'], 'alpha.pdf', { type: 'application/pdf' })

    await expect(uploadDocument(file)).rejects.toThrow('知识库上传接口')
  })

  it('turns add document 405 errors into a knowledge-disabled hint', async () => {
    apiPost.mockRejectedValueOnce({ status: 405, message: 'Method Not Allowed' })

    const { addDocument } = await import('../knowledge')

    await expect(addDocument('Spec', 'content')).rejects.toThrow('知识库暂不可用')
  })

  it('knowledge.ts keeps zh keyword tables outside the API file', async () => {
    const sourceCode = await import('../knowledge?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("from '@/config/knowledge-errors'")
    expect(raw).not.toContain('知识库暂不可用，请重启应用后重试')
    expect(raw).not.toContain('当前后端未提供知识库上传接口，请检查 HexClaw 后端版本')
    expect(raw).not.toContain("msg.includes('未提供知识库上传接口')")
    expect(raw).not.toContain("message.includes('文件格式错误')")
  })

  it('classifies backend unsupported-format responses without starting a second upload path', async () => {
    const { isKnowledgeUploadUnsupportedFormat } = await import('../knowledge')

    expect(isKnowledgeUploadUnsupportedFormat({ status: 415, message: 'Unsupported Media Type' })).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('不支持的文件格式'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('网络错误'))).toBe(false)
  })
})
