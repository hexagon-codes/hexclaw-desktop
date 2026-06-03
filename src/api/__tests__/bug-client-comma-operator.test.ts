// BUG-client-comma-operator regression test
//
// Bug: src/api/client.ts:57 `if (body instanceof FormData) opts.body = body, opts.headers = {}`
//   用逗号操作符当语句序列，eslint no-unused-expressions FAIL，可读性差且潜在踩坑。
//
// 修复后契约：
//   1. eslint 不再报 no-unused-expressions error
//   2. FormData 上传时 opts.body 与 opts.headers 仍正确两个都被赋值
//   3. source 不再含逗号操作符（用 block 替代）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('BUG-client-comma-operator', () => {
  it('source 不应含 `opts.body = body, opts.headers` 逗号操作符语句序列', () => {
    const src = readFileSync(resolve(__dirname, '../client.ts'), 'utf-8')
    // 强契约：FormData 分支不能用逗号操作符
    expect(src).not.toMatch(/opts\.body\s*=\s*body\s*,\s*opts\.headers/)
  })

  it('FormData 上传时 opts.body 与 opts.headers 必须两个都被赋值', async () => {
    // 行为契约：通过实际调用 apiPost(FormData) 验证 fetch 收到的 body 是 FormData
    // 且不带 Content-Type header（让浏览器自动设带 boundary 的 multipart 头）
    const fakeFormData = new FormData()
    fakeFormData.append('field', 'value')

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true }),
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      const { apiPost } = await import('../client')
      await apiPost('/test', fakeFormData)

      expect(fetchMock).toHaveBeenCalled()
      const callArgs = fetchMock.mock.calls[0]
      const fetchInit = callArgs?.[1] as RequestInit

      // body 必须是 FormData
      expect(fetchInit.body).toBe(fakeFormData)
      // headers 不应含 Content-Type（让浏览器自动加 multipart boundary）
      const headers = new Headers(fetchInit.headers)
      expect(headers.get('content-type')).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
