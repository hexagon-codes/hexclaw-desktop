import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  raw: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: { raw: h.raw },
  apiGet: h.get,
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import { k12ExportArchive } from '@/api/k12'

describe('K12 LearningArchive export HTTP contract', () => {
  beforeEach(() => {
    h.raw.mockReset()
    h.get.mockReset()
  })

  it('PDF/DOCX directly consumes binary artifact and response metadata', async () => {
    h.raw.mockResolvedValue({
      _data: new Blob(['%PDF-archive'], { type: 'application/pdf' }),
      headers: new Headers({
        'content-type': 'application/pdf',
        'content-disposition':
          "attachment; filename*=UTF-8''%E5%B0%8F%E6%98%8E_%E5%AD%A6%E4%B9%A0%E6%A1%A3%E6%A1%88_%E4%BA%94%E5%B9%B4%E7%BA%A7%E4%B8%8A.pdf",
        'x-hexclaw-artifact-id': 'artifact-1',
        'x-hexclaw-source-digest': 'sha256:archive',
        'x-hexclaw-object-counts': '{"mistakes":1}',
      }),
    })

    const result = await k12ExportArchive('mingming', 'pdf')

    expect(h.raw).toHaveBeenCalledWith('/api/k12/export', {
      method: 'GET',
      query: { agent: 'mingming', format: 'pdf' },
      responseType: 'blob',
    })
    expect(result).toMatchObject({
      filename: '小明_学习档案_五年级上.pdf',
      contentType: 'application/pdf',
      artifactId: 'artifact-1',
      sourceDigest: 'sha256:archive',
      objectCounts: { mistakes: 1 },
    })
    expect(result).toHaveProperty('blob')
  })

  it('Markdown keeps the JSON canonical artifact path', async () => {
    const markdown = { format: 'markdown', content: '# archive', artifact_id: 'artifact-1' }
    h.get.mockResolvedValue(markdown)

    await expect(k12ExportArchive('mingming', 'md')).resolves.toBe(markdown)
    expect(h.get).toHaveBeenCalledWith('/api/k12/export', { agent: 'mingming', format: 'md' })
    expect(h.raw).not.toHaveBeenCalled()
  })

  it.each([
    [
      'encoded path separator',
      "attachment; filename*=UTF-8''..%2F..%2Fprivate.pdf",
    ],
    ['quoted backslash path', 'attachment; filename="..\\\\private.pdf"'],
    ['control character', 'attachment; filename="archive\u0007.pdf"'],
  ])('rejects an unsafe server filename (%s)', async (_name, contentDisposition) => {
    h.raw.mockResolvedValue({
      _data: new Blob(['%PDF-archive'], { type: 'application/pdf' }),
      headers: new Headers({
        'content-type': 'application/pdf',
        'content-disposition': contentDisposition,
        'x-hexclaw-artifact-id': 'artifact-1',
        'x-hexclaw-source-digest': 'sha256:archive',
        'x-hexclaw-object-counts': '{}',
      }),
    })

    await expect(k12ExportArchive('mingming', 'pdf')).rejects.toThrow(/filename|metadata|安全/i)
  })
})
