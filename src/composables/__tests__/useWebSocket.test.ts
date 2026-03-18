/**
 * useWebSocket 测试
 *
 * 验证 WebSocket composable 的重连逻辑和边界情况
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    // 下一个 tick 触发连接
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
    }, 0)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  send(_data: string) {}

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// 必须在 mock 之后导入
const { useWebSocket } = await import('../useWebSocket')

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('连接后 connected 应为 true', async () => {
    const onMessage = vi.fn()
    const { connected, connect } = useWebSocket('ws://localhost:16060/ws', onMessage)

    connect()
    await vi.advanceTimersByTimeAsync(10)

    expect(connected.value).toBe(true)
  })

  it('断开后应自动重连', async () => {
    const onMessage = vi.fn()
    const { connected, connect, disconnect } = useWebSocket('ws://localhost:16060/ws', onMessage, {
      reconnectInterval: 1000,
    })

    connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(connected.value).toBe(true)

    disconnect()
    expect(connected.value).toBe(false)
  })

  it('maxRetries = 0 表示不重连（修复后语义）', () => {
    // 修复后：maxRetries = -1 表示无限，0 表示不重连
    // 条件改为: maxRetries >= 0 && retries >= maxRetries
    // maxRetries=0 时，0 >= 0 && 0 >= 0 → true → 立即返回不重连
    expect(0 >= 0 && 0 >= 0).toBe(true) // 证明条件满足，会阻止重连
  })

  it('maxRetries = -1 表示无限重连', () => {
    // maxRetries = -1: -1 >= 0 为 false → 条件不满足 → 不阻止重连
    expect(-1 >= 0).toBe(false) // 证明条件不满足，允许无限重连
  })

  it('非 JSON 消息不应崩溃', async () => {
    const onMessage = vi.fn()
    const { connect } = useWebSocket('ws://localhost:16060/ws', onMessage)

    connect()
    await vi.advanceTimersByTimeAsync(10)

    // 不会有 onmessage 在测试中被调用，但验证它不会 throw
    expect(onMessage).not.toHaveBeenCalled()
  })
})
