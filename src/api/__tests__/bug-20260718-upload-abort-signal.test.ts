/**
 * BUG-20260718 · 组B-4 · client.apiPost(FormData) 丢调用方 AbortSignal
 *
 * §15 红灯：FormData 上传分支只用内部 timeout 造的 controller，忽略调用方传入的
 * options.signal → 拍照/教材/作品"取消"后仍继续上传并写对象。
 * 修复：把调用方 signal 透传进 uploadFormData，与内部 timeout 合并，任一 abort 即中止。
 *
 * 关联门：PLATAPI-110、PHOTO-014、KNOW-003/012/015、E2E-ASYNC-001
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060', timeout: 30000, logLevel: 'warn' } }))
vi.mock('@/utils/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
beforeEach(() => vi.restoreAllMocks())

describe('BUG-20260718 apiPost(FormData) 透传取消信号', () => {
  it('[bug] 预取消的调用方 signal → fetch 收到 aborted signal 并中止', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        captured = init.signal ?? undefined
        if (init.signal?.aborted) {
          return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: 1 }) })
      }),
    )
    const { apiPost } = await import('../client')
    const ctrl = new AbortController()
    ctrl.abort()
    const fd = new FormData()
    fd.append('file', 'x')
    await expect(apiPost('/api/v1/knowledge/upload', fd, { signal: ctrl.signal })).rejects.toThrow()
    expect(captured?.aborted).toBe(true)
  })

  it('[bug] 上传进行中调用 abort() 会中止 fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            )
          }),
      ),
    )
    const { apiPost } = await import('../client')
    const ctrl = new AbortController()
    const fd = new FormData()
    fd.append('file', 'x')
    const p = apiPost('/api/v1/knowledge/upload', fd, { signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toThrow()
  })
})

describe('轮询 GET 透传取消信号', () => {
  it('调用方 abort() 会中止仍在等待的 apiGet', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            captured = init.signal ?? undefined
            const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (init.signal?.aborted) fail()
            else init.signal?.addEventListener('abort', fail, { once: true })
          }),
      ),
    )
    const { apiGet } = await import('../client')
    const ctrl = new AbortController()
    const pending = apiGet(
      '/api/k12/image-tasks/dispatch-a',
      { agent: 'mingming' },
      { signal: ctrl.signal },
    )
    ctrl.abort()

    await expect(pending).rejects.toThrow()
    expect(captured?.aborted).toBe(true)
  })
})
