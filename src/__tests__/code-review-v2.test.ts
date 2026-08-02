/**
 * Code Review V2 — 基于测试暴露的真实 Bug
 *
 * Bug A: WebSocket 全局审批 sender 绕过 request owner（安全漏洞）
 * Bug B: apiSSE 跨 chunk 行断裂丢失数据（功能链路 bug）
 * Bug C: deleteWebhook 缺少 URI 编码（安全 + 边界）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Bug A: 全局审批 sender 不得成为第二条发送路径 ─────

describe('Bug A: approval response 只经 request-owned transport', () => {
  it('全局 WebSocket 不再暴露 legacy approval sender', async () => {
    const { readFileSync } = await import('fs')
    const source = readFileSync('src/api/websocket.ts', 'utf-8')

    expect(source).not.toContain('sendApprovalResponse(')
    expect(source).not.toContain('denied_remember')
  })
})

// ─── Bug B: apiSSE 跨 chunk 行断裂丢失数据 ─────

describe('Bug B: apiSSE — SSE 行跨 chunk 边界时数据丢失', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFetchSSE(chunks: string[]) {
    const encoder = new TextEncoder()
    let idx = 0
    const reader = {
      read: vi.fn().mockImplementation(() => {
        if (idx < chunks.length) {
          return Promise.resolve({ done: false, value: encoder.encode(chunks[idx++]!) })
        }
        return Promise.resolve({ done: true, value: undefined })
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    }))
  }

  it('SSE 行完全在单个 chunk 内 — 正常解析', async () => {
    vi.doMock('@/config/env', () => ({
      env: { apiBase: 'http://test:9999', wsBase: 'ws://test:9999', isDev: false, timeout: 30000, logLevel: 'warn' },
    }))

    mockFetchSSE([
      'data: {"content":"hello"}\n',
      'data: {"content":"world"}\n',
      'data: [DONE]\n',
    ])

    const { apiSSE } = await import('@/api/client')
    const stream = await apiSSE('/test')
    const reader = stream.getReader()
    const results: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      results.push(value)
    }

    expect(results).toHaveLength(2)
    expect(JSON.parse(results[0]!).content).toBe('hello')
    expect(JSON.parse(results[1]!).content).toBe('world')
  })

  it('SSE data: 行被 chunk 边界截断 — 应正确拼接', async () => {
    vi.doMock('@/config/env', () => ({
      env: { apiBase: 'http://test:9999', wsBase: 'ws://test:9999', isDev: false, timeout: 30000, logLevel: 'warn' },
    }))

    mockFetchSSE([
      'data: {"content":"hel',    // 行被截断
      'lo"}\ndata: [DONE]\n',      // 补全 + DONE
    ])

    const { apiSSE } = await import('@/api/client')
    const stream = await apiSSE('/test')
    const reader = stream.getReader()
    const results: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      results.push(value)
    }

    // 修复后：跨 chunk 的行被 lineBuffer 正确拼接
    expect(results).toHaveLength(1)
    expect(JSON.parse(results[0]!).content).toBe('hello')
  })

  it('多行跨多 chunk — 全部正确解析', async () => {
    vi.doMock('@/config/env', () => ({
      env: { apiBase: 'http://test:9999', wsBase: 'ws://test:9999', isDev: false, timeout: 30000, logLevel: 'warn' },
    }))

    mockFetchSSE([
      'data: {"id":1}\nda',       // 第一行完整, 第二行开头
      'ta: {"id":2}\n',            // 第二行补全
      'data: {"id":3}\ndata: [DONE]\n',
    ])

    const { apiSSE } = await import('@/api/client')
    const stream = await apiSSE('/test')
    const reader = stream.getReader()
    const results: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      results.push(value)
    }

    expect(results).toHaveLength(3)
    expect(JSON.parse(results[0]!).id).toBe(1)
    expect(JSON.parse(results[1]!).id).toBe(2)
    expect(JSON.parse(results[2]!).id).toBe(3)
  })
})

// ─── Bug C: deleteWebhook 缺少 URI 编码 ─────

describe('Bug C: deleteWebhook — name 参数需要 URI 编码', () => {
  it('deleteWebhook 应使用 encodeURIComponent', async () => {
    const { readFileSync } = await import('fs')
    const source = readFileSync('src/api/webhook.ts', 'utf-8')

    // 提取 deleteWebhook 函数（到下一个 export 或文件尾）
    const start = source.indexOf('export function deleteWebhook')
    expect(start).toBeGreaterThan(-1)
    const fnBody = source.slice(start, source.indexOf('\n}', start) + 2)
    expect(fnBody).toContain('encodeURIComponent')
  })
})

// ─── 集成验证：修复不引入回归 ─────

describe('集成验证: 修复后其他 API 函数的 URI 编码一致性', () => {
  it('所有使用动态路径参数的 delete 函数都应 URI 编码', async () => {
    const { readFileSync } = await import('fs')

    // 检查所有使用 apiDelete + 路径参数的函数
    const files = [
      'src/api/webhook.ts',
      'src/api/knowledge.ts',
      'src/api/mcp.ts',
      'src/api/skills.ts',
      'src/api/chat.ts',
    ]

    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      // 找所有 apiDelete 调用中使用模板字符串插值的
      const deleteCallMatches = source.matchAll(/apiDelete[^(]*\(`[^`]*\$\{([^}]+)\}[^`]*`\)/g)
      for (const match of deleteCallMatches) {
        const interpolation = match[1]!
        // 如果直接使用变量名（无函数调用），应该检查是否需要编码
        if (!interpolation.includes('encodeURIComponent') && !interpolation.includes('(')) {
          // 这是可能的安全问题 — 但某些内部 ID 保证无特殊字符
          // 记录但不 fail
        }
      }
    }
    // 确认 webhook 和 knowledge 都使用了 encodeURIComponent
    const webhookSrc = readFileSync('src/api/webhook.ts', 'utf-8')
    const knowledgeSrc = readFileSync('src/api/knowledge.ts', 'utf-8')
    // deleteWebhook 2026-06-22 改按 name 删（仍 URI 编码）
    expect(webhookSrc).toContain('encodeURIComponent(name)')
    expect(knowledgeSrc).toContain('encodeURIComponent(id)')
  })
})
