import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  payload: null as string | null,
  cancelBody: vi.fn(),
}))

vi.mock('ofetch', () => ({
  ofetch: { create: vi.fn(() => vi.fn()) },
}))
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
vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('../native-sidecar-websocket', () => ({ NativeSidecarWebSocket: class {} }))
vi.mock('../native-sidecar-stream', () => ({
  sidecarStreamFetch: vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (native.payload !== null) {
          controller.enqueue(new TextEncoder().encode(native.payload))
        }
      },
      cancel: native.cancelBody,
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }),
}))

describe('apiSSE native stream ownership', () => {
  beforeEach(() => {
    native.payload = null
    native.cancelBody.mockReset()
  })

  it('propagates consumer cancellation to the native response body', async () => {
    const { apiSSE } = await import('../client')
    const output = await apiSSE('/api/v1/cron/jobs/stream')

    await output.getReader().cancel('consumer-left')

    expect(native.cancelBody).toHaveBeenCalledExactlyOnceWith('consumer-left')
  })

  it('releases the native response body when the SSE sentinel ends the wrapper', async () => {
    native.payload = 'data: [DONE]\n'
    const { apiSSE } = await import('../client')
    const output = await apiSSE('/api/v1/cron/jobs/stream')

    await expect(output.getReader().read()).resolves.toMatchObject({ done: true })
    expect(native.cancelBody).toHaveBeenCalledOnce()
  })
})
