/**
 * Bug 3 复现: pullOllamaModel 流式解析 — 最后一行无换行符时丢失
 *
 * 不 mock @/api/ollama，直接测真实的 pullOllamaModel 解析逻辑。
 * 只 mock fetch 来控制 ReadableStream 内容。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('@/config/env', () => ({ OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://test:9999' } }))

function mockFetchWithChunks(chunks: string[]) {
  const encoder = new TextEncoder()
  let index = 0
  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (index < chunks.length) {
        return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]!) })
      }
      return Promise.resolve({ done: true, value: undefined })
    }),
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    body: { getReader: () => reader },
  }))
}

describe('Bug 3: pullOllamaModel 流最后一行丢失', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('最后一行有换行符 — 正常解析（基线）', async () => {
    mockFetchWithChunks([
      'data: {"status":"downloading","completed":500,"total":1000}\n',
      'data: {"status":"success"}\n',
    ])

    const { pullOllamaModel } = await import('@/api/ollama')
    const updates: { status: string }[] = []
    await pullOllamaModel('test', (p) => updates.push(p as { status: string }))

    expect(updates).toHaveLength(2)
    expect(updates[0]!.status).toBe('downloading')
    expect(updates[1]!.status).toBe('success')
  })

  it('最后一行无换行符 — 修复前丢失 success', async () => {
    mockFetchWithChunks([
      'data: {"status":"downloading","completed":500,"total":1000}\n',
      'data: {"status":"success"}',  // ← 无 \n
    ])

    const { pullOllamaModel } = await import('@/api/ollama')
    const updates: { status: string }[] = []
    await pullOllamaModel('test', (p) => updates.push(p as { status: string }))

    // 修复前 FAIL: updates.length === 1 (success 丢失)
    // 修复后 PASS: updates.length === 2
    expect(updates).toHaveLength(2)
    expect(updates[1]!.status).toBe('success')
  })

  it('跨 chunk 拼接 + 最后残留行', async () => {
    mockFetchWithChunks([
      'data: {"status":"pull',
      'ing","completed":100,"total":200}\ndata: {"status":"success"}',
    ])

    const { pullOllamaModel } = await import('@/api/ollama')
    const updates: { status: string }[] = []
    await pullOllamaModel('test', (p) => updates.push(p as { status: string }))

    // 修复前 FAIL: ���有 "pulling", "success" 残留在 buffer
    // 修复后 PASS: 两条都被解析
    expect(updates).toHaveLength(2)
    expect(updates[0]!.status).toBe('pulling')
    expect(updates[1]!.status).toBe('success')
  })

  it('error 在最后一行无换行符时仍被捕获', async () => {
    mockFetchWithChunks([
      'data: {"status":"downloading","completed":500,"total":1000}\n',
      'data: {"status":"error","error":"model not found"}', // 无 \n
    ])

    const { pullOllamaModel } = await import('@/api/ollama')
    const updates: { status: string; error?: string }[] = []

    await expect(
      pullOllamaModel('nonexistent', (p) => updates.push(p as { status: string; error?: string })),
    ).rejects.toThrow('model not found')
  })
})
