/**
 * 回归测试 — C-03（2026-06-22 hex-test 审计）：
 * onerror 设置 error.value 后，紧随其后的 onclose 不应把它抹成 null，
 * 否则 UI 永远看不到"WebSocket 连接错误"。error 仅应在成功 onopen 时清空。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

let lastWS: MockWS | null = null

class MockWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  url: string
  readyState = MockWS.CONNECTING
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 测试 mock：把实例暴露给用例以触发 onerror/onclose
    lastWS = this
    setTimeout(() => {
      this.readyState = MockWS.OPEN
      this.onopen?.(new Event('open'))
    }, 0)
  }
  send() {}
  close() {
    this.readyState = MockWS.CLOSED
    this.onclose?.()
  }
}

vi.stubGlobal('WebSocket', MockWS)
const { useWebSocket } = await import('../useWebSocket')

describe('useWebSocket — C-03 error 不被 onclose 抹除', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('onerror 后 onclose 不应清空 error（maxRetries=0 不重连）', async () => {
    let api: ReturnType<typeof useWebSocket> | null = null
    const wrapper = mount(defineComponent({
      setup() {
        api = useWebSocket('ws://localhost:16060/ws', vi.fn(), { maxRetries: 0 })
        return () => null
      },
    }))
    api!.connect()
    await vi.advanceTimersByTimeAsync(10) // onopen → connected, error=null

    lastWS!.onerror?.() // 连接错误
    expect(api!.error.value).toBe('WebSocket 连接错误')

    lastWS!.onclose?.() // 错误后必随的 close —— 不应抹除 error
    expect(api!.error.value).toBe('WebSocket 连接错误')

    wrapper.unmount()
  })
})
