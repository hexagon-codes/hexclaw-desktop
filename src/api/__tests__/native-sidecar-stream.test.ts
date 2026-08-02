import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:8787',
  },
}))
vi.mock('@tauri-apps/api/core', () => {
  class Channel<T> {
    constructor(private readonly listener: (event: T) => void) {}

    emit(event: T) {
      this.listener(event)
    }
  }

  return {
    Channel,
    invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
      tauri.calls.push({ command, args })
      if (command === 'sidecar_stream_open') {
        const channel = args.onEvent as Channel<Record<string, unknown>>
        channel.emit({ type: 'open', status: 200, headers: { 'content-type': 'text/event-stream' } })
        channel.emit({ type: 'chunk', data: [111, 107] })
        channel.emit({ type: 'end' })
        return 'stream-id'
      }
      return undefined
    }),
  }
})

describe('native Sidecar stream request normalization', () => {
  beforeEach(() => {
    tauri.calls.length = 0
  })

  it('accepts an app-relative URL but forwards only a managed relative path', async () => {
    const { sidecarStreamFetch } = await import('../native-sidecar-stream')
    const response = await sidecarStreamFetch('/api/v1/cron/jobs/stream?scope=desktop', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(await response.text()).toBe('ok')
    const open = tauri.calls.find((call) => call.command === 'sidecar_stream_open')
    expect(open?.args.request).toMatchObject({
      method: 'POST',
      path: '/api/v1/cron/jobs/stream?scope=desktop',
    })
  })
})
