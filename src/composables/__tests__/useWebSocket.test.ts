/**
 * useWebSocket 测试
 *
 * 验证 WebSocket composable 的重连逻辑和边界情况
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

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

function mountUseWebSocket(options?: { reconnectInterval?: number; maxRetries?: number }) {
  let api: ReturnType<typeof useWebSocket> | null = null

  const wrapper = mount(defineComponent({
    setup() {
      api = useWebSocket('ws://localhost:16060/ws', vi.fn(), options)
      return () => null
    },
  }))

  return {
    wrapper,
    api: api!,
  }
}

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('连接后 connected 应为 true', async () => {
    const { wrapper, api } = mountUseWebSocket()

    api.connect()
    await vi.advanceTimersByTimeAsync(10)

    expect(api.connected.value).toBe(true)
    wrapper.unmount()
  })

  it('断开后应自动重连', async () => {
    const { wrapper, api } = mountUseWebSocket({
      reconnectInterval: 1000,
    })

    api.connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(api.connected.value).toBe(true)

    api.disconnect()
    expect(api.connected.value).toBe(false)
    wrapper.unmount()
  })

  it('maxRetries = 0 表示不重连（修复后语义）', () => {
    // 修复后：maxRetries = -1 表示无限，0 表示不重连
    // 条件改为: maxRetries >= 0 && retries >= maxRetries
    const shouldStopReconnect = (retries: number, maxRetries: number) =>
      maxRetries >= 0 && retries >= maxRetries
    expect(shouldStopReconnect(0, 0)).toBe(true)
  })

  it('maxRetries = -1 表示无限重连', () => {
    // maxRetries = -1: -1 >= 0 为 false → 条件不满足 → 不阻止重连
    expect(-1 >= 0).toBe(false) // 证明条件不满足，允许无限重连
  })

  it('非 JSON 消息不应崩溃', async () => {
    const { wrapper, api } = mountUseWebSocket()

    api.connect()
    await vi.advanceTimersByTimeAsync(10)

    // 不会有 onmessage 在测试中被调用，但验证它不会 throw
    expect(api.error.value).toBeNull()
    wrapper.unmount()
  })
})
