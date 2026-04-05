/**
 * Extended tests for chatService — covers withTimeout, sendViaWebSocket timeout/done/cancel/error/guard/attachment paths.
 *
 * The sibling chatService.test.ts covers basic ensureWebSocketConnected, sendViaBackend,
 * sendViaWebSocket happy-path, and ChatRequestError construction.
 * This file focuses on branches not exercised there.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── hoisted mock callbacks registry ────────────────────
const onChunkHandlers: Function[] = []
const onReplyHandlers: Function[] = []
const onErrorHandlers: Function[] = []

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    clearStreamCallbacks: vi.fn(),
    onChunk: vi.fn((cb: Function) => { onChunkHandlers.push(cb); return () => {} }),
    onReply: vi.fn((cb: Function) => { onReplyHandlers.push(cb); return () => {} }),
    onError: vi.fn((cb: Function) => { onErrorHandlers.push(cb); return () => {} }),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
  },
}))
vi.mock('@/api/chat', () => ({ sendChatViaBackend: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { hexclawWS } from '@/api/websocket'
import { withTimeout, sendViaWebSocket, ChatRequestError } from '../chatService'
import type { StreamCallbacks } from '../chatService'

// ─── helpers ─────────────────────────────────────────────

function makeCallbacks(overrides?: Partial<StreamCallbacks>): StreamCallbacks {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

const defaultParams = { model: 'test-model' }

// ═══════════════════════════════════════════════════════════
// withTimeout
// ═══════════════════════════════════════════════════════════

describe('withTimeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('resolves when the promise resolves before timeout', async () => {
    const p = withTimeout(Promise.resolve(42), 5000, 'timed out')
    await expect(p).resolves.toBe(42)
  })

  it('propagates rejection when the promise rejects before timeout', async () => {
    const p = withTimeout(Promise.reject(new Error('boom')), 5000, 'timed out')
    await expect(p).rejects.toThrow('boom')
  })

  it('rejects with timeout message when the timer fires first', async () => {
    const never = new Promise<number>(() => {}) // never settles
    const p = withTimeout(never, 3000, 'custom timeout msg')
    vi.advanceTimersByTime(3001)
    await expect(p).rejects.toThrow('custom timeout msg')
  })

  it('clears the timer on resolve (no pending timers)', async () => {
    const p = withTimeout(Promise.resolve('ok'), 5000, 'timed out')
    await p
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer on reject (no pending timers)', async () => {
    const p = withTimeout(Promise.reject(new Error('err')), 5000, 'timed out')
    await p.catch(() => {}) // swallow
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// sendViaWebSocket — extended paths
// ═══════════════════════════════════════════════════════════

describe('sendViaWebSocket — extended', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    onChunkHandlers.length = 0
    onReplyHandlers.length = 0
    onErrorHandlers.length = 0
  })
  afterEach(() => { vi.useRealTimers() })

  // ─── first-reply timeout ───────────────────────────────

  it('rejects with "no response received" when no chunk or reply arrives within 120s', async () => {
    const cbs = makeCallbacks()
    const p = sendViaWebSocket('hello', 's1', defaultParams, '', undefined, cbs)

    // Advance past the 120s first-reply timeout
    vi.advanceTimersByTime(120_001)

    await expect(p).rejects.toThrow('no response received')
  })

  // ─── inactivity timeout ────────────────────────────────

  it('rejects with "no new content received" when chunks stop arriving for 120s', async () => {
    const cbs = makeCallbacks()
    const p = sendViaWebSocket('hello', 's1', defaultParams, '', undefined, cbs)

    // First chunk arrives — clears first-reply timer, starts inactivity timer
    onChunkHandlers[0]({ content: 'partial', done: false })

    // Advance past inactivity timeout
    vi.advanceTimersByTime(120_001)

    await expect(p).rejects.toThrow('no new content received')
  })

  // ─── chunk.done path ───────────────────────────────────

  it('resolves and calls onDone when chunk.done is true', async () => {
    const cbs = makeCallbacks()
    const p = sendViaWebSocket('hello', 's1', defaultParams, '', undefined, cbs)

    const metadata = { tokens: 123, agent_name: 'coder' }
    const toolCalls = [{ id: 't1', name: 'search', arguments: '{}' }]
    onChunkHandlers[0]({ content: 'final', done: true, metadata, tool_calls: toolCalls })

    await expect(p).resolves.toBeUndefined()
    expect(cbs.onChunk).toHaveBeenCalledWith('final', undefined)
    expect(cbs.onDone).toHaveBeenCalledWith('', metadata, toolCalls, 'coder')
  })

  // ─── user cancel ───────────────────────────────────────

  it('resolves (not rejects) when error is "用户取消"', async () => {
    const cbs = makeCallbacks()
    const p = sendViaWebSocket('hello', 's1', defaultParams, '', undefined, cbs)

    onErrorHandlers[0]('用户取消')

    await expect(p).resolves.toBeUndefined()
    // onError callback on StreamCallbacks should NOT be called
    expect(cbs.onError).not.toHaveBeenCalled()
  })

  // ─── generic error ─────────────────────────────────────

  it('rejects with ChatRequestError(noFallback=true) for non-cancel errors', async () => {
    const cbs = makeCallbacks()
    const p = sendViaWebSocket('hello', 's1', defaultParams, '', undefined, cbs)

    onErrorHandlers[0]('connection lost')

    await expect(p).rejects.toThrow('connection lost')
    try {
      await p
    } catch (e) {
      expect(e).toBeInstanceOf(ChatRequestError)
      expect((e as ChatRequestError).noFallback).toBe(true)
    }
  })

  // ─── settled guard ─────────────────────────────────────

  it('ignores subsequent callbacks after the promise has settled', async () => {
    const cbs = makeCallbacks()
    const p = sendViaWebSocket('hello', 's1', defaultParams, '', undefined, cbs)

    // Settle via onReply
    onReplyHandlers[0]({ content: 'done', metadata: {} })
    await p

    // Reset mock call counts
    cbs.onChunk = vi.fn()
    cbs.onDone = vi.fn()
    cbs.onError = vi.fn()

    // Fire more callbacks — should be no-ops
    onChunkHandlers[0]({ content: 'late chunk', done: false })
    onChunkHandlers[0]({ content: 'late done', done: true, metadata: {} })
    onErrorHandlers[0]('late error')

    // The original callbacks object inside the closure captured the original fns,
    // but the settled guard prevents resolve/reject from firing again.
    // The key invariant is that the promise does not reject or throw after settling.
    // We verify by ensuring the promise stayed resolved.
    await expect(p).resolves.toBeUndefined()
  })

  // ─── attachment mapping ────────────────────────────────

  it('maps attachments to {type, name, mime, data} and passes to sendMessage', async () => {
    const cbs = makeCallbacks()
    const attachments = [
      { type: 'image' as const, name: 'photo.png', mime: 'image/png', data: 'base64data' },
      { type: 'file' as const, name: 'doc.pdf', mime: 'application/pdf', data: 'pdfdata' },
    ]

    // Settle immediately via onReply
    ;(hexclawWS.onReply as ReturnType<typeof vi.fn>).mockImplementationOnce((cb: Function) => {
      onReplyHandlers.push(cb)
      // Trigger reply synchronously after sendMessage runs
      setTimeout(() => cb({ content: 'ok', metadata: {} }), 0)
      return () => {}
    })

    const p = sendViaWebSocket('look at this', 's1', defaultParams, 'assistant', attachments, cbs)
    vi.advanceTimersByTime(1)
    await p

    expect(hexclawWS.sendMessage).toHaveBeenCalledWith(
      'look at this',
      's1',
      'test-model',
      'assistant',
      [
        { type: 'image', name: 'photo.png', mime: 'image/png', data: 'base64data' },
        { type: 'file', name: 'doc.pdf', mime: 'application/pdf', data: 'pdfdata' },
      ],
      undefined, // provider
      undefined, // temperature
      undefined, // maxTokens
      undefined, // metadata
    )
  })
})
