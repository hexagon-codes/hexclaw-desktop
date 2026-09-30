import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
  delayed: false,
  resolve: undefined as ((id: string) => void) | undefined,
  reject: undefined as ((error: Error) => void) | undefined,
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class<T> {
    constructor(private readonly listener: (event: T) => void) {}
    emit(event: T) { this.listener(event) }
  },
  invoke: (command: string, args: Record<string, unknown>) => {
    native.calls.push({ command, args })
    if (command.endsWith('_open')) {
      if (native.delayed) return new Promise<string>((resolve, reject) => {
        native.resolve = resolve
        native.reject = reject
      })
      return Promise.resolve('original-connection')
    }
    return Promise.resolve()
  },
}))

const initial = {
  connectionId: 'local', backendId: 'backend-a', configRevision: 1,
  activationGeneration: 1, kind: 'local' as const,
  apiBase: 'http://localhost:16060', wsBase: 'ws://localhost:16060', hasToken: true,
}
const transitions = [
  { name: 'A to B', next: { ...initial, connectionId: 'remote', backendId: 'backend-b', activationGeneration: 2 } },
  { name: 'A to B to A', next: { ...initial, activationGeneration: 3 } },
  { name: 'same URL with new backend', next: { ...initial, backendId: 'replacement-backend' } },
]

async function channel(command: string) {
  await vi.waitFor(() => expect(native.calls.some((call) => call.command === command)).toBe(true))
  return native.calls.find((call) => call.command === command)!.args.onEvent as {
    emit(event: Record<string, unknown>): void
  }
}

describe('native transport backend ownership', () => {
  beforeEach(async () => {
    vi.resetModules()
    native.calls = []
    native.delayed = false
    native.resolve = undefined
    native.reject = undefined
    const { backendContext } = await import('@/services/backend-context')
    backendContext.value = { ...initial }
  })

  it.each(transitions)('stops SSE content after $name', async ({ next }) => {
    const { backendContext } = await import('@/services/backend-context')
    const { sidecarStreamFetch } = await import('../native-sidecar-stream')
    const pending = sidecarStreamFetch('/api/v1/stream')
    const events = await channel('sidecar_stream_open')
    events.emit({ type: 'open', status: 200 })
    const reader = (await pending).body!.getReader()
    events.emit({ type: 'chunk', data: [65] })
    expect((await reader.read()).value).toEqual(new Uint8Array([65]))
    backendContext.value = next
    const rejected = reader.read()
    events.emit({ type: 'chunk', data: [66] })
    events.emit({ type: 'error', message: 'old upstream error' })
    await expect(rejected).rejects.toThrow('Backend connection changed')
    await vi.waitFor(() => expect(native.calls.map((call) => call.command)).toEqual([
      'sidecar_stream_open', 'sidecar_stream_cancel',
    ]))
    expect(native.calls[1]!.args).toEqual({ streamId: 'original-connection' })
  })

  it.each(transitions)('stops WebSocket content and errors after $name', async ({ next }) => {
    const { backendContext } = await import('@/services/backend-context')
    const { NativeSidecarWebSocket } = await import('../native-sidecar-websocket')
    const socket = new NativeSidecarWebSocket('/ws')
    const opened = vi.fn(), messages = vi.fn(), errors = vi.fn()
    socket.onopen = opened
    socket.onmessage = messages
    socket.onerror = errors
    const events = await channel('sidecar_socket_open')
    events.emit({ type: 'open' })
    events.emit({ type: 'message', data: 'current' })
    expect(messages).toHaveBeenCalledTimes(1)
    backendContext.value = next
    events.emit({ type: 'message', data: 'stale' })
    events.emit({ type: 'error', message: 'stale error' })
    events.emit({ type: 'open' })
    expect(messages).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(native.calls.map((call) => call.command)).toEqual([
      'sidecar_socket_open', 'sidecar_socket_close',
    ]))
    expect(native.calls[1]!.args).toEqual({ socketId: 'original-connection' })
    events.emit({ type: 'close', code: 1000, was_clean: true })
    expect(socket.readyState).toBe(NativeSidecarWebSocket.CLOSED)
  })

  it.each(['stream', 'socket'])('releases only the original delayed %s ID', async (transport) => {
    native.delayed = true
    const { backendContext } = await import('@/services/backend-context')
    let outcome: Promise<unknown>
    if (transport === 'stream') {
      const { sidecarStreamFetch } = await import('../native-sidecar-stream')
      outcome = sidecarStreamFetch('/api/v1/stream').catch((error: Error) => error.message)
    } else {
      const { NativeSidecarWebSocket } = await import('../native-sidecar-websocket')
      const socket = new NativeSidecarWebSocket('/ws')
      socket.onopen = () => { throw new Error('stale open must not be published') }
      outcome = Promise.resolve('closed')
    }
    const events = await channel(`sidecar_${transport}_open`)
    backendContext.value = transitions[0]!.next
    events.emit({ type: 'open', status: 200 })
    expect(native.calls).toHaveLength(1)
    native.resolve!('late-original-id')
    expect(await outcome).toBe(transport === 'stream' ? 'Backend connection changed' : 'closed')
    await vi.waitFor(() => expect(native.calls).toHaveLength(2))
    expect(native.calls[1]).toEqual({
      command: transport === 'stream' ? 'sidecar_stream_cancel' : 'sidecar_socket_close',
      args: transport === 'stream' ? { streamId: 'late-original-id' } : { socketId: 'late-original-id' },
    })
  })

  it('discards a late native open rejection without forwarding the old error', async () => {
    native.delayed = true
    const { backendContext } = await import('@/services/backend-context')
    const { NativeSidecarWebSocket } = await import('../native-sidecar-websocket')
    const socket = new NativeSidecarWebSocket('/ws')
    const errors = vi.fn()
    socket.onerror = errors
    await channel('sidecar_socket_open')
    backendContext.value = transitions[0]!.next
    native.reject!(new Error('old service unavailable'))
    await vi.waitFor(() => expect(socket.readyState).toBe(NativeSidecarWebSocket.CLOSED))
    expect(errors).not.toHaveBeenCalled()
    expect(native.calls).toHaveLength(1)
  })
})
