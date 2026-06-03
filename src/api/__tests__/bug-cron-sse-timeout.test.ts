/**
 * bug-cron-sse-timeout — 守卫 BUG-A：createCronJobSSE 无超时兜底。
 *
 * 复现场景（2026-05-27 装机）：
 *   本地 qwen3.5:9b 编译 cron 脚本 >200s，或服务器只发 progress 永不发 done/error。
 *   旧 createCronJobSSE 的 reader.read() 无限 block → 前端"执行中"卡死永不返回。
 *
 * RED（修复前）：mock 一个只发 1 帧 progress 然后永不结束的 SSE 流，
 *   createCronJobSSE 永远不 reject → 本测试在 vitest test-timeout 内 FAIL。
 *
 * GREEN（修复后）：传 timeoutMs=200 → 200ms 后 abort → reject 含「超时」的友好错误。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/config/env', () => ({ env: { apiBase: 'http://test-host' } }))
vi.mock('@/constants', () => ({ DESKTOP_USER_ID: 'desktop-user' }))
// apiClient 不应被 SSE 路径用到，但 import 链需要它存在
vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}))

describe('BUG-A: createCronJobSSE 超时兜底', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('流只发 progress 永不结束 → timeoutMs 后 reject「超时」而非卡死', async () => {
    // 永不结束的 SSE 流：发 1 帧 progress，之后 reader.read() 永远 pending
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: progress\ndata: {"stage":"calling_llm","message":"调用 LLM…"}\n\n',
          ),
        )
        // 故意不 controller.close() —— 模拟后端 hold 住连接
      },
    })

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { createCronJobSSE } = await import('@/api/tasks')

    const progressSeen: string[] = []
    await expect(
      createCronJobSSE(
        { name: 'x', schedule: '@daily', prompt: 'y' },
        {
          onProgress: (p) => progressSeen.push(p.stage),
          timeoutMs: 200,
        },
      ),
    ).rejects.toThrow(/超时/)

    // 超时前应至少收到 1 帧 progress（证明流是活的，只是没收尾）
    expect(progressSeen).toContain('calling_llm')
  }, 3000) // vitest 测试超时 3s：修复前永不 reject → 3s 内 FAIL

  it('外部 signal abort 仍能中断（不与超时冲突）', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* 永不发任何数据，永不 close */
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const ac = new AbortController()
    const { createCronJobSSE } = await import('@/api/tasks')
    const p = createCronJobSSE(
      { name: 'x', schedule: '@daily', prompt: 'y' },
      { onProgress: () => {}, signal: ac.signal, timeoutMs: 5000 },
    )
    // 50ms 后用户主动取消
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toThrow()
  }, 3000)
})
