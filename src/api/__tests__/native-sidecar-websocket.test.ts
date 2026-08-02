import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/platform', () => ({ isTauri: () => false }))
vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:8787',
    wsBase: 'ws://localhost:8787',
  },
}))

class BrowserSocketDouble extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = BrowserSocketDouble.CONNECTING
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    super()
    this.url = url
  }

  open() {
    this.readyState = BrowserSocketDouble.OPEN
    const event = new Event('open')
    this.onopen?.(event)
    this.dispatchEvent(event)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = BrowserSocketDouble.CLOSED
    const event = Object.assign(new Event('close'), {
      code: 1000,
      reason: '',
      wasClean: true,
    }) as CloseEvent
    this.onclose?.(event)
    this.dispatchEvent(event)
  }
}

describe('NativeSidecarWebSocket browser compatibility boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('WebSocket', BrowserSocketDouble)
  })

  it('preserves the browser development transport without invoking Tauri', async () => {
    const { NativeSidecarWebSocket } = await import('../native-sidecar-websocket')
    const socket = new NativeSidecarWebSocket('/ws')
    const delegate = (socket as unknown as { browserSocket: BrowserSocketDouble }).browserSocket

    expect(delegate).toBeInstanceOf(BrowserSocketDouble)
    expect(delegate.url).toBe('ws://localhost:8787/ws')
    delegate.open()
    expect(socket.readyState).toBe(NativeSidecarWebSocket.OPEN)

    socket.send('hello')
    expect(delegate.sent).toEqual(['hello'])
  })
})
