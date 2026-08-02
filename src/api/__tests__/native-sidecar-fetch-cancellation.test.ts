import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
  rejectFetch: null as ((error: Error) => void) | null,
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:16060',
    wsBase: 'ws://localhost:16060',
    timeout: 30_000,
    logLevel: 'warn',
  },
}))
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class<T> {
    constructor(private readonly listener: (event: T) => void) {}

    emit(event: T) {
      this.listener(event)
    }
  },
  invoke: vi.fn((command: string, args: Record<string, unknown>) => {
    native.calls.push({ command, args })
    if (command === 'sidecar_fetch') {
      return new Promise((_resolve, reject) => {
        native.rejectFetch = reject
      })
    }
    return Promise.resolve(undefined)
  }),
}))

describe('native Sidecar HTTP cancellation boundary', () => {
  beforeEach(() => {
    native.calls.length = 0
    native.rejectFetch = null
  })

  it('sends the same cancellation identity while the Rust HTTP request is still pending', async () => {
    const { sidecarFetch } = await import('../client')
    const abort = new AbortController()
    const pending = sidecarFetch('/api/v1/knowledge/operations', { signal: abort.signal })

    await vi.waitFor(() => {
      expect(native.calls.some((call) => call.command === 'sidecar_fetch')).toBe(true)
    })
    const fetchCall = native.calls.find((call) => call.command === 'sidecar_fetch')!
    expect(fetchCall.args.cancellationId).toEqual(expect.any(String))

    abort.abort()
    expect(native.calls.some((call) => call.command === 'sidecar_fetch_cancel')).toBe(false)
    const registered = fetchCall.args.onRegistered as { emit(event: null): void }
    expect(registered).toEqual(expect.any(Object))
    registered.emit(null)
    await vi.waitFor(() => {
      expect(native.calls.some((call) => call.command === 'sidecar_fetch_cancel')).toBe(true)
    })
    const cancelCall = native.calls.find((call) => call.command === 'sidecar_fetch_cancel')!
    expect(cancelCall.args.cancellationId).toBe(fetchCall.args.cancellationId)

    native.rejectFetch?.(new Error('Sidecar request cancelled'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
