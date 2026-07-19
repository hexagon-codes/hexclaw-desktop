/**
 * BUG-20260718 · 组D-6 · WebSocket 回调无 request/session 分流（防串）
 *
 * §15 红灯：全局 WebSocket 的 chunk/reply/error 回调对所有消息广播，两孩/两请求
 * 并发或重连迟到的陈旧消息会串到别的请求上。
 *
 * 修复（安全前端层）：onChunk/onReply/onError 新增可选 scope（sessionId/requestId）。
 * 分发时"只丢弃明确异源"的消息——消息带有非空且不同的 request_id/session_id 才丢弃；
 * 后端未回填该字段时一律投递（零回归）。未传 scope 的旧调用方行为不变。
 *
 * 关联门：PLATAPI-115/185、PLATROUTE-143、E2E-MULTI-001/CRASH-001
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private _listeners: Record<string, Array<{ handler: EventListener; once: boolean }>> = {}
  constructor() { MockWebSocket.instances.push(this) }
  addEventListener(type: string, handler: EventListener, opts?: { once?: boolean } | boolean) {
    const once = typeof opts === 'object' ? !!opts.once : false
    ;(this._listeners[type] ??= []).push({ handler, once })
  }
  removeEventListener(type: string, handler: EventListener) {
    if (this._listeners[type]) this._listeners[type] = this._listeners[type]!.filter((l) => l.handler !== handler)
  }
  send() {}
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
  simulateOpen() { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')) }
  simulateMessage(data: string) { this.onmessage?.(new MessageEvent('message', { data })) }
}

vi.stubGlobal('WebSocket', MockWebSocket)

const { hexclawWS } = await import('../../api/websocket')

async function connected(): Promise<MockWebSocket> {
  const p = hexclawWS.connect()
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
  ws.simulateOpen()
  await p
  return ws
}

describe('BUG-20260718 WebSocket 回调 scope 分流', () => {
  beforeEach(() => { hexclawWS.disconnect(); MockWebSocket.instances = [] })
  afterEach(() => hexclawWS.disconnect())

  it('[bug] scope 到 requestId 的回调丢弃明确异源的 chunk', async () => {
    const ws = await connected()
    const mine = vi.fn()
    hexclawWS.onChunk(mine, { requestId: 'req-A' })
    ws.simulateMessage(JSON.stringify({ type: 'chunk', content: 'foreign', request_id: 'req-B' }))
    ws.simulateMessage(JSON.stringify({ type: 'chunk', content: 'mine', request_id: 'req-A' }))
    expect(mine).toHaveBeenCalledTimes(1)
    expect(mine.mock.calls[0]![0].content).toBe('mine')
  })

  it('后端未回填 request_id 时仍投递（零回归）', async () => {
    const ws = await connected()
    const cb = vi.fn()
    hexclawWS.onChunk(cb, { requestId: 'req-A' })
    ws.simulateMessage(JSON.stringify({ type: 'chunk', content: 'no-id' }))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('未传 scope 的旧调用方收到所有消息', async () => {
    const ws = await connected()
    const cb = vi.fn()
    hexclawWS.onReply(cb)
    ws.simulateMessage(JSON.stringify({ type: 'reply', content: 'x', request_id: 'whatever' }))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('scope 到 sessionId 丢弃明确异源的 error', async () => {
    const ws = await connected()
    const cb = vi.fn()
    hexclawWS.onError(cb, { sessionId: 's-1' })
    ws.simulateMessage(JSON.stringify({ type: 'error', content: 'boom', session_id: 's-2' }))
    expect(cb).not.toHaveBeenCalled()
    ws.simulateMessage(JSON.stringify({ type: 'error', content: 'mine', session_id: 's-1' }))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
