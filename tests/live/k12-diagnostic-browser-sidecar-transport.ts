import type { Page } from '@playwright/test'

/**
 * Test-only bridge for an isolated C02 Sidecar. Production Tauri keeps its
 * native transport; the LIVE browser lane opts into this explicitly.
 */
export function diagnosticBrowserSidecarTransportInitScript(isolatedSidecarURL: string): void {
  const releaseSidecarOrigin = 'http://localhost:16060'
  const rewrite = (raw: string, transport: 'http' | 'websocket' = 'http'): string => {
    try {
      const source = new URL(raw, window.location.href)
      const isReleaseSidecar =
        transport === 'websocket'
          ? source.hostname === 'localhost' &&
            source.port === '16060' &&
            (source.protocol === 'ws:' || source.protocol === 'wss:')
          : source.origin === releaseSidecarOrigin
      if (!isReleaseSidecar) return raw
      const target = new URL(isolatedSidecarURL)
      source.protocol =
        transport === 'websocket' ? (target.protocol === 'https:' ? 'wss:' : 'ws:') : target.protocol
      source.hostname = target.hostname
      source.port = target.port
      return source.toString()
    } catch {
      return raw
    }
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return nativeFetch(rewrite(input), init)
    if (input instanceof URL) return nativeFetch(rewrite(input.toString()), init)
    if (input instanceof Request) {
      const rewritten = rewrite(input.url)
      if (rewritten !== input.url) return nativeFetch(new Request(rewritten, input), init)
    }
    return nativeFetch(input, init)
  }) as typeof window.fetch

  const nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: [] | [async: boolean, username?: string | null, password?: string | null]
  ): void {
    const rewritten = rewrite(String(url))
    Reflect.apply(nativeOpen, this, [method, rewritten, ...rest])
  }

  const NativeWebSocket = window.WebSocket
  class RewrittenWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(rewrite(String(url), 'websocket'), protocols)
    }
  }
  window.WebSocket = RewrittenWebSocket

  if (typeof window.EventSource === 'function') {
    const NativeEventSource = window.EventSource
    class RewrittenEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(rewrite(String(url)), init)
      }
    }
    window.EventSource = RewrittenEventSource
  }
}

export async function installDiagnosticBrowserSidecarBridge(
  page: Page,
  isolatedSidecarURL: string | null,
): Promise<void> {
  if (!isolatedSidecarURL) return
  await page.addInitScript(diagnosticBrowserSidecarTransportInitScript, isolatedSidecarURL)
}
