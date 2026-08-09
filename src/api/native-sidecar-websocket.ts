/** Browser-compatible facade over the authenticated Rust Sidecar socket. */

import { env } from '@/config/env'
import { isTauri } from '@/utils/platform'

interface NativeSocketEvent {
  type: 'open' | 'message' | 'error' | 'close'
  data?: string
  message?: string
  code?: number
  reason?: string
  was_clean?: boolean
}

export class NativeSidecarWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = NativeSidecarWebSocket.CONNECTING
  readonly OPEN = NativeSidecarWebSocket.OPEN
  readonly CLOSING = NativeSidecarWebSocket.CLOSING
  readonly CLOSED = NativeSidecarWebSocket.CLOSED

  readonly url: string
  readonly protocol = ''
  readonly extensions = ''
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  readyState = NativeSidecarWebSocket.CONNECTING

  onopen: ((this: NativeSidecarWebSocket, event: Event) => unknown) | null = null
  onmessage: ((this: NativeSidecarWebSocket, event: MessageEvent<string>) => unknown) | null = null
  onerror: ((this: NativeSidecarWebSocket, event: Event) => unknown) | null = null
  onclose: ((this: NativeSidecarWebSocket, event: CloseEvent) => unknown) | null = null

  private socketId: string | null = null
  private browserSocket: WebSocket | null = null
  private closeRequested = false
  private nativeCommandQueue: Promise<void> = Promise.resolve()

  constructor(path: string) {
    super()
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new DOMException('Sidecar WebSocket path is invalid', 'SyntaxError')
    }
    if (!isTauri()) {
      this.url = new URL(path, env.wsBase).toString()
      this.connectBrowser()
      return
    }
    this.url = path
    void this.connectNative(path)
  }

  private connectBrowser() {
    const socket = new WebSocket(this.url)
    this.browserSocket = socket
    socket.onopen = () => this.emitOpen()
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.emitMessage(event.data)
      else this.emitError('Binary Sidecar WebSocket messages are forbidden')
    }
    socket.onerror = () => this.emitError('Sidecar WebSocket connection failed')
    socket.onclose = (event) => {
      this.emitClose(event?.code ?? 1000, event?.reason ?? '', event?.wasClean ?? true)
    }
  }

  private emitOpen() {
    if (this.readyState !== NativeSidecarWebSocket.CONNECTING) return
    this.readyState = NativeSidecarWebSocket.OPEN
    const event = new Event('open')
    this.onopen?.call(this, event)
    this.dispatchEvent(event)
  }

  private emitMessage(data: string) {
    if (this.readyState !== NativeSidecarWebSocket.OPEN) return
    const event = new MessageEvent<string>('message', { data })
    this.onmessage?.call(this, event)
    this.dispatchEvent(event)
  }

  private emitError(message: string) {
    const event = new Event('error')
    Object.defineProperty(event, 'message', { value: message, enumerable: true })
    this.onerror?.call(this, event)
    this.dispatchEvent(event)
  }

  private emitClose(code = 1006, reason = '', wasClean = false) {
    if (this.readyState === NativeSidecarWebSocket.CLOSED) return
    this.readyState = NativeSidecarWebSocket.CLOSED
    const event = typeof CloseEvent === 'undefined'
      ? Object.assign(new Event('close'), { code, reason, wasClean }) as CloseEvent
      : new CloseEvent('close', { code, reason, wasClean })
    this.onclose?.call(this, event)
    this.dispatchEvent(event)
  }

  private enqueueNativeCommand(command: string, args: Record<string, unknown>): Promise<void> {
    this.nativeCommandQueue = this.nativeCommandQueue
      .then(async () => {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke(command, args)
      })
      .catch((error) => {
        this.emitError(error instanceof Error ? error.message : String(error))
      })
    return this.nativeCommandQueue
  }

  private async connectNative(path: string) {
    try {
      const { Channel, invoke } = await import('@tauri-apps/api/core')
      const onEvent = new Channel<NativeSocketEvent>((event) => {
        if (event.type === 'open') this.emitOpen()
        else if (event.type === 'message') this.emitMessage(event.data ?? '')
        else if (event.type === 'error') this.emitError(event.message ?? 'Sidecar WebSocket failed')
        else if (event.type === 'close') {
          this.emitClose(event.code, event.reason, event.was_clean)
        }
      })
      this.socketId = await invoke<string>('sidecar_socket_open', { path, onEvent })
      if (this.closeRequested) {
        await this.enqueueNativeCommand('sidecar_socket_close', { socketId: this.socketId })
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error.message : String(error))
      this.emitClose()
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (
      this.readyState !== NativeSidecarWebSocket.OPEN
      || (!this.browserSocket && !this.socketId)
    ) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError')
    }
    if (typeof data !== 'string') {
      throw new DOMException('Binary Sidecar WebSocket messages are forbidden', 'NotSupportedError')
    }
    if (this.browserSocket) {
      this.browserSocket.send(data)
      return
    }
    void this.enqueueNativeCommand('sidecar_socket_send', { socketId: this.socketId, data })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === NativeSidecarWebSocket.CLOSED) return
    this.closeRequested = true
    this.readyState = NativeSidecarWebSocket.CLOSING
    if (this.browserSocket) {
      this.browserSocket.close(code, reason)
      return
    }
    if (!this.socketId) return
    void this.enqueueNativeCommand('sidecar_socket_close', { socketId: this.socketId })
  }
}
