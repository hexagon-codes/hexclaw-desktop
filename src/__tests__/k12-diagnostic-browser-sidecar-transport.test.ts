import { afterEach, describe, expect, it, vi } from 'vitest'

import { diagnosticBrowserSidecarTransportInitScript } from '../../tests/live/k12-diagnostic-browser-sidecar-transport'

const originalFetch = window.fetch
const originalWebSocket = window.WebSocket
const originalOpen = XMLHttpRequest.prototype.open
const originalEventSource = window.EventSource

afterEach(() => {
  window.fetch = originalFetch
  window.WebSocket = originalWebSocket
  XMLHttpRequest.prototype.open = originalOpen
  window.EventSource = originalEventSource
})

describe('K12 diagnostic browser Sidecar transport', () => {
  it('routes the release WebSocket origin to the isolated WebSocket origin', () => {
    const websocketURLs: string[] = []
    const fetchURLs: string[] = []

    class CapturingWebSocket {
      constructor(url: string | URL) {
        websocketURLs.push(String(url))
      }
    }

    window.WebSocket = CapturingWebSocket as unknown as typeof WebSocket
    window.fetch = vi.fn((input: RequestInfo | URL) => {
      fetchURLs.push(typeof input === 'string' ? input : input.toString())
      return Promise.resolve(new Response())
    }) as typeof window.fetch

    diagnosticBrowserSidecarTransportInitScript('http://127.0.0.1:41701')

    new window.WebSocket('ws://localhost:16060/ws?transport=k12')
    new window.WebSocket('wss://third-party.example/ws')
    void window.fetch('http://localhost:16060/api/v1/agents')
    void window.fetch('https://third-party.example/api')

    expect(websocketURLs).toEqual([
      'ws://127.0.0.1:41701/ws?transport=k12',
      'wss://third-party.example/ws',
    ])
    expect(fetchURLs).toEqual([
      'http://127.0.0.1:41701/api/v1/agents',
      'https://third-party.example/api',
    ])
  })

  it('keeps XHR and EventSource on the same isolated HTTP transport only for the release origin', () => {
    const xhrURLs: string[] = []
    const eventSourceURLs: string[] = []
    const nativeOpen = vi.fn((_method: string, url: string | URL) => {
      xhrURLs.push(String(url))
    })

    class CapturingEventSource {
      constructor(url: string | URL) {
        eventSourceURLs.push(String(url))
      }
    }

    XMLHttpRequest.prototype.open = nativeOpen as unknown as typeof XMLHttpRequest.prototype.open
    window.EventSource = CapturingEventSource as unknown as typeof EventSource

    diagnosticBrowserSidecarTransportInitScript('http://127.0.0.1:41701')

    new XMLHttpRequest().open('GET', 'http://localhost:16060/api/v1/events')
    new XMLHttpRequest().open('GET', 'https://third-party.example/events')
    new window.EventSource('http://localhost:16060/events?stream=k12')
    new window.EventSource('https://third-party.example/events')

    expect(xhrURLs).toEqual([
      'http://127.0.0.1:41701/api/v1/events',
      'https://third-party.example/events',
    ])
    expect(eventSourceURLs).toEqual([
      'http://127.0.0.1:41701/events?stream=k12',
      'https://third-party.example/events',
    ])
  })

  it('upgrades a release WebSocket to wss only when the isolated target is TLS', () => {
    const websocketURLs: string[] = []

    class CapturingWebSocket {
      constructor(url: string | URL) {
        websocketURLs.push(String(url))
      }
    }

    window.WebSocket = CapturingWebSocket as unknown as typeof WebSocket

    diagnosticBrowserSidecarTransportInitScript('https://127.0.0.1:41703')

    new window.WebSocket('wss://localhost:16060/ws?transport=k12')

    expect(websocketURLs).toEqual(['wss://127.0.0.1:41703/ws?transport=k12'])
  })
})
