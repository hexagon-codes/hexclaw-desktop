/**
 * FS-5（BUG-20260703）：后端返回 `{"error":"中文错误"}` 时，ofetch 抛出的
 * FetchError.message 是 `[POST] "url": 400 Bad Request`，组件用 e.message 弹 toast
 * → 用户永远看不到后端的中文错误。契约：客户端统一把 body.error 提到 e.message。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060', wsBase: 'ws://localhost:16060', timeout: 30000, logLevel: 'warn' },
}))
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('FS-5 后端 body.error 提取到 e.message', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('apiPost 失败时 e.message 应为后端 error 字段而非 ofetch 状态串', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: '指定的 provider "Openrouter" 已禁用，请先在设置中启用' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const { apiPost } = await import('../client')
    await expect(apiPost('/api/v1/agents', { name: 'x' })).rejects.toThrow(
      '指定的 provider "Openrouter" 已禁用，请先在设置中启用',
    )
  })

  it('body.message 也支持（部分端点用 message 而非 error）', async () => {
    // mockImplementation 每次返回新 Response——ofetch 对部分状态会重试，
    // 复用同一 Response 会「Body already read」（测试环境 artifact，非产品行为）。
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ message: '配额已达上限' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })),
    ))

    const { apiGet } = await import('../client')
    await expect(apiGet('/api/v1/cron/jobs')).rejects.toThrow('配额已达上限')
  })

  it('非 JSON body 时不覆盖原始错误（降级到状态串）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    ))

    const { apiGet } = await import('../client')
    // 只要抛错即可（不崩、不吞），message 非空
    await expect(apiGet('/api/v1/cron/jobs')).rejects.toThrow()
  })
})
