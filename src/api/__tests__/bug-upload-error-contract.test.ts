// BUG-upload-error-contract regression test
//
// Bug: uploadFormData 错误路径与 ofetch JSON 路径契约不对齐：
//   1. server 返 body={error:'detail'} 时 ofetch 拿到 detail，FormData 路径只拿 statusText
//   2. FormData 路径没 logger.debug 调用链路
//   3. timeout=0/负数 在 FormData 路径会立刻 abort（JSON 路径有 >0 guard）
//
// 修复后契约：
//   1. server body.error 必须出现在抛出的 error message 里
//   2. timeout <=0 必须忽略，回退 env.timeout
//   3. logger.debug 必须有 '→ POST' / '← ' 链路日志

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('BUG-upload-error-contract', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    vi.resetModules()
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('server 返 body.error detail 时 error message 必须含 detail（不只 statusText）', async () => {
    // 模拟真实 Response.clone() 行为：clone 返回新对象可独立 .json()
    const buildResponse = () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: '知识库索引器爆炸了' }),
      text: async () => '{"error":"知识库索引器爆炸了"}',
      clone: () => buildResponse(),
    })
    globalThis.fetch = vi.fn().mockResolvedValue(buildResponse()) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('file', new Blob(['x']))

    // RED 状态（修前）：msg 只含 'Internal Server Error'
    // GREEN 状态（修后）：msg 必须含 '知识库索引器爆炸了'
    await expect(apiPost('/api/v1/knowledge/upload', fd)).rejects.toThrow('知识库索引器爆炸了')
  })

  it('timeout=0 必须不立即 abort（行为对齐 JSON 路径）', async () => {
    // 用 fast-resolving fetch 验证 timeout=0 时不抛 AbortError
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')

    // RED 状态：timeout=0 会立即 controller.abort() → 报错
    // GREEN 状态：timeout<=0 应该 fallback env.timeout
    await expect(apiPost('/x', fd, { timeout: 0 })).resolves.toEqual({ ok: true })
  })

  it('timeout 负数同样应被忽略', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }) as unknown as typeof fetch

    const { apiPost } = await import('../client')
    const fd = new FormData()
    fd.append('f', 'v')
    await expect(apiPost('/x', fd, { timeout: -1 })).resolves.toEqual({ ok: true })
  })
})
