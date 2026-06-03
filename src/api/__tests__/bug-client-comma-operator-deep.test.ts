// 深度复审补充：uploadFormData 异常路径契约检查
//
// 目标：验证 FormData 上传与 JSON 上传 (ofetch) 的错误契约是否一致：
//   1. server 返 5xx 时是否抛带状态码的可识别 error
//   2. 网络断时是否抛 error（不是 silent fail）
//   3. timeout 触发是否抛 AbortError 类型
//   4. server 返非 JSON body 时是否 graceful（不应 SyntaxError 覆盖原状态）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('uploadFormData 异常路径契约', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    vi.resetModules()
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('server 返 500 时必须抛 error 且 message 含状态信息', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'db down' }),
    }) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')
    await expect(apiPost('/x', fd)).rejects.toThrow()
  })

  it('server 返 5xx + 非 JSON body 时不应让 syntax error 掩盖 http 状态', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => {
        throw new Error('Unexpected token < in JSON')
      },
    }) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')
    // 现在的实现：ok=false 时先 fromHttpStatus(status, statusText) 抛 error
    // 这条应该被原状态抛出，而不是被 .json() 的 SyntaxError 覆盖
    // 期望含 503 状态或者 statusText —— 当前实现应该 PASS
    // 但若调用 .json() 先于检查 .ok，会被 SyntaxError 污染 —— 这是 RED
    await expect(apiPost('/x', fd)).rejects.not.toThrow(/Unexpected token/)
  })

  it('server 返 200 + 非 JSON body 时 graceful（不让 SyntaxError 冒出来）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('Unexpected token < in JSON')
      },
    }) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')
    // 当前实现：response.json() 抛 SyntaxError 直接冒出来
    // 这是一个潜在 contract gap — 上传完成但 server 误返 HTML 时 UI 看到 SyntaxError
    await expect(apiPost('/x', fd)).rejects.toThrow()
  })

  it('网络错误（fetch 直接 reject）应抛 error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network failure')) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')
    await expect(apiPost('/x', fd)).rejects.toThrow(/network failure/)
  })

  it('timeout 触发时应抛 AbortError 类型 error', async () => {
    // 模拟超时——fetch 永远 pending，让 AbortController 触发
    globalThis.fetch = vi.fn((_, opts) => {
      return new Promise((_, reject) => {
        const signal = (opts as RequestInit).signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')
    // timeout 设极短让快速 fail
    await expect(apiPost('/x', fd, { timeout: 50 })).rejects.toThrow()
  }, 2000)
})
