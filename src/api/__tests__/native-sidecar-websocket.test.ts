import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeHarness = vi.hoisted(() => ({
  enabled: false,
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
  eventHandler: undefined as ((event: Record<string, unknown>) => void) | undefined,
  resolveSend: undefined as (() => void) | undefined,
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => nativeHarness.enabled }))
vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:8787',
    wsBase: 'ws://localhost:8787/_hexclaw',
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(handler: (event: Record<string, unknown>) => void) {
      nativeHarness.eventHandler = handler
    }
  },
  invoke: (command: string, args: Record<string, unknown>) => {
    nativeHarness.calls.push({ command, args })
    if (command === 'sidecar_socket_open') return Promise.resolve('socket-1')
    if (command === 'sidecar_socket_send') {
      return new Promise<void>((resolve) => {
        nativeHarness.resolveSend = resolve
      })
    }
    return Promise.resolve()
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
    nativeHarness.enabled = false
    nativeHarness.calls = []
    nativeHarness.eventHandler = undefined
    nativeHarness.resolveSend = undefined
    vi.stubGlobal('WebSocket', BrowserSocketDouble)
  })

  it('preserves the browser development transport without invoking Tauri', async () => {
    const { NativeSidecarWebSocket } = await import('../native-sidecar-websocket')
    const socket = new NativeSidecarWebSocket('/ws')
    const delegate = (socket as unknown as { browserSocket: BrowserSocketDouble }).browserSocket

    expect(delegate).toBeInstanceOf(BrowserSocketDouble)
    expect(delegate.url).toBe('ws://localhost:8787/_hexclaw/ws')
    delegate.open()
    expect(socket.readyState).toBe(NativeSidecarWebSocket.OPEN)

    socket.send('hello')
    expect(delegate.sent).toEqual(['hello'])
  })

  it('serializes native send before close so request cancel cannot be overtaken', async () => {
    nativeHarness.enabled = true
    const { NativeSidecarWebSocket } = await import('../native-sidecar-websocket')
    const socket = new NativeSidecarWebSocket('/ws')

    await vi.waitFor(() => {
      expect(nativeHarness.calls.map((call) => call.command)).toEqual(['sidecar_socket_open'])
      expect((socket as unknown as { socketId: string | null }).socketId).toBe('socket-1')
    })
    nativeHarness.eventHandler?.({ type: 'open' })
    expect(socket.readyState).toBe(NativeSidecarWebSocket.OPEN)

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req-idle' }))
    socket.close()

    await vi.waitFor(() => {
      expect(nativeHarness.calls.map((call) => call.command)).toContain('sidecar_socket_send')
    })
    expect(nativeHarness.calls.map((call) => call.command)).not.toContain('sidecar_socket_close')

    nativeHarness.resolveSend?.()
    await vi.waitFor(() => {
      expect(nativeHarness.calls.map((call) => call.command)).toEqual([
        'sidecar_socket_open',
        'sidecar_socket_send',
        'sidecar_socket_close',
      ])
    })
  })
})
