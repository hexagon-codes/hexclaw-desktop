import { isTauri } from '@/utils/platform'

interface NativeStreamEvent {
  type: 'open' | 'chunk' | 'end' | 'error'
  status?: number
  headers?: Record<string, string>
  data?: number[]
  message?: string
}

export async function sidecarStreamFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isTauri()) return await globalThis.fetch(input, init)

  const { env } = await import('@/config/env')
  const raw = input instanceof Request ? input.url : input.toString()
  const url = new URL(raw, env.apiBase)
  const base = new URL(env.apiBase)
  if (url.origin !== base.origin) return await globalThis.fetch(input, init)
  const path = `${url.pathname}${url.search}`
  const request = new Request(input instanceof Request ? input : url.toString(), init)
  const body = request.body ? Array.from(new Uint8Array(await request.arrayBuffer())) : []
  const headers = Object.fromEntries(request.headers.entries())
  const { Channel, invoke } = await import('@tauri-apps/api/core')

  let streamId: string | null = null
  let cancelPending = false
  let opened = false
  let terminal = false
  let resolveOpen!: (response: Response) => void
  let rejectOpen!: (error: Error) => void
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let cleanupAbort = () => {}
  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const cancelNative = async () => {
    if (!streamId) {
      cancelPending = true
      return
    }
    await invoke('sidecar_stream_cancel', { streamId })
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      terminal = true
      cleanupAbort()
      return cancelNative()
    },
  })
  const fail = (message: string) => {
    if (terminal) return
    terminal = true
    cleanupAbort()
    const error = new Error(message)
    if (!opened) rejectOpen(error)
    else controller?.error(error)
  }
  const onEvent = new Channel<NativeStreamEvent>((event) => {
    if (terminal) return
    if (event.type === 'open') {
      opened = true
      resolveOpen(
        new Response(stream, {
          status: event.status ?? 500,
          headers: event.headers,
        }),
      )
    } else if (event.type === 'chunk') {
      controller?.enqueue(Uint8Array.from(event.data ?? []))
    } else if (event.type === 'end') {
      terminal = true
      cleanupAbort()
      controller?.close()
    } else if (event.type === 'error') {
      fail(event.message ?? 'Sidecar stream failed')
    }
  })

  const onAbort = () => {
    void cancelNative()
    fail('Sidecar stream aborted')
  }
  cleanupAbort = () => request.signal.removeEventListener('abort', onAbort)
  if (request.signal.aborted) {
    onAbort()
  } else {
    request.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    streamId = await invoke<string>('sidecar_stream_open', {
      request: { method: request.method, path, headers, body },
      onEvent,
    })
    if (cancelPending) await cancelNative()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  return await responsePromise
}
