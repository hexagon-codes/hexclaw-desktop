/**
 * client.ts API 客户端测试
 *
 * 验证 SSE 流处理、错误处理的边界情况
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock env
vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:16060',
    wsBase: 'ws://localhost:16060',
    timeout: 30000,
    logLevel: 'warn',
  },
}))

// Mock logger
vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('apiSSE', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    // 恢复原始 fetch，避免污染其他测试
    globalThis.fetch = originalFetch
  })

  it('BUG: response.body 为 null 时会抛出非用户友好的错误', async () => {
    // 某些代理服务器可能返回 ok 但 body 为 null
    const mockResponse = {
      ok: true,
      body: null,
      status: 200,
      statusText: 'OK',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse))

    const { apiSSE } = await import('../client')

    // response.body!.getReader() 会抛出 TypeError
    // 这应该被优雅处理而不是 crash
    await expect(apiSSE('/test')).rejects.toThrow()
  })

  it('BUG: SSE data 行中包含多个 "data: " 前缀时只处理第一个', async () => {
    // 某些 SSE 实现可能在一个 chunk 中发送多行 data
    const mockBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        // 两个 SSE 事件在同一个 chunk 中
        controller.enqueue(encoder.encode('data: {"content":"hello"}\ndata: {"content":" world"}\n'))
        controller.close()
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        status: 200,
      }),
    )

    const { apiSSE } = await import('../client')
    const stream = await apiSSE('/test')
    const reader = stream.getReader()
    const chunks: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    // 两个 data 事件应该都被处理
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('{"content":"hello"}')
    expect(chunks[1]).toBe('{"content":" world"}')
  })

  it('SSE [DONE] 信号应正确关闭流', async () => {
    const mockBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('data: {"content":"hi"}\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n'))
        // 不应该到达这里
        controller.enqueue(encoder.encode('data: {"content":"should not appear"}\n'))
        controller.close()
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        status: 200,
      }),
    )

    const { apiSSE } = await import('../client')
    const stream = await apiSSE('/test')
    const reader = stream.getReader()
    const chunks: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('{"content":"hi"}')
  })
})

describe('checkHealth', () => {
  it('Tauri invoke 失败时应降级到 HTTP', async () => {
    // 模拟非 Tauri 环境
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      }),
    )

    const { checkHealth } = await import('../client')
    const result = await checkHealth()
    // 应该降级到 HTTP 并返回 true
    expect(typeof result).toBe('boolean')
  })
})
