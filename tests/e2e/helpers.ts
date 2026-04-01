/**
 * Shared E2E test utilities for HexClaw Playwright tests.
 *
 * NOTE: This module uses the `ws` npm package for WebSocket.
 * If not already installed, run:
 *   pnpm add -D ws @types/ws
 */

import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASE_URL = 'http://localhost:16060'
export const WS_URL = 'ws://localhost:16060/ws'
export const USER_ID = 'e2e-playwright'

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ApiResponse {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

/**
 * Call the sidecar HTTP API.
 *
 * @param method  HTTP method (GET, POST, PUT, DELETE, ...)
 * @param path    Path starting with "/" — appended to BASE_URL
 * @param body    Optional JSON-serialisable body (sent for non-GET methods)
 */
export async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResponse> {
  const url = `${BASE_URL}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-ID': USER_ID,
  }

  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }

  const res = await fetch(url, init)
  const text = await res.text()

  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    data = { raw: text }
  }

  return { status: res.status, data }
}

// ---------------------------------------------------------------------------
// WebSocket chat helper
// ---------------------------------------------------------------------------

export interface ChatResult {
  /** Concatenated content text from all chunks / final reply */
  content: string
  /** Concatenated reasoning text (thinking mode) */
  reasoning: string
  /** Metadata returned on the final chunk or reply */
  metadata: Record<string, unknown>
  /** Token usage info returned on the final chunk or reply */
  usage: Record<string, unknown>
  /** Tool calls collected across all chunks */
  toolCalls: unknown[]
  /** Total number of chunk messages received */
  chunks: number
}

interface WsChatOptions {
  sessionId?: string
  provider?: string
  model?: string
  metadata?: Record<string, string>
  /** Timeout in milliseconds (default 120 000) */
  timeoutMs?: number
}

/**
 * Open a one-shot WebSocket connection, send a chat message, and collect
 * streaming chunks until the server signals completion (`done: true` or
 * `type: "reply"`).
 *
 * @param content  The user message to send
 * @param options  Optional overrides (session, provider, model, metadata, timeout)
 */
export function wsChat(
  content: string,
  options: WsChatOptions = {},
): Promise<ChatResult> {
  const {
    sessionId,
    provider,
    model,
    metadata,
    timeoutMs = 120_000,
  } = options

  return new Promise<ChatResult>((resolve, reject) => {
    const ws = new WebSocket(WS_URL)

    let timer: ReturnType<typeof setTimeout> | undefined

    const result: ChatResult = {
      content: '',
      reasoning: '',
      metadata: {},
      usage: {},
      toolCalls: [],
      chunks: 0,
    }

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    // Timeout guard
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`wsChat timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    ws.on('open', () => {
      const msg: Record<string, unknown> = {
        type: 'message',
        content,
        user_id: USER_ID,
      }

      if (sessionId !== undefined) msg.session_id = sessionId
      if (provider !== undefined) msg.provider = provider
      if (model !== undefined) msg.model = model
      if (metadata !== undefined && Object.keys(metadata).length > 0) {
        msg.metadata = metadata
      }

      ws.send(JSON.stringify(msg))
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        // Non-JSON frame — ignore
        return
      }

      const msgType = data.type as string | undefined

      if (msgType === 'chunk') {
        result.chunks += 1

        if (typeof data.content === 'string') {
          result.content += data.content
        }
        if (typeof data.reasoning === 'string') {
          result.reasoning += data.reasoning
        }
        if (Array.isArray(data.tool_calls)) {
          result.toolCalls.push(...(data.tool_calls as unknown[]))
        }

        // The final chunk carries usage / metadata and sets done: true
        if (data.done === true) {
          if (data.usage !== undefined && data.usage !== null) {
            result.usage = data.usage as Record<string, unknown>
          }
          if (data.metadata !== undefined && data.metadata !== null) {
            result.metadata = data.metadata as Record<string, unknown>
          }
          cleanup()
          resolve(result)
        }
      } else if (msgType === 'reply') {
        // Some backends send a single "reply" instead of chunked stream
        if (typeof data.content === 'string') {
          result.content = data.content
        }
        if (typeof data.reasoning === 'string') {
          result.reasoning = data.reasoning
        }
        if (data.usage !== undefined && data.usage !== null) {
          result.usage = data.usage as Record<string, unknown>
        }
        if (data.metadata !== undefined && data.metadata !== null) {
          result.metadata = data.metadata as Record<string, unknown>
        }
        if (Array.isArray(data.tool_calls)) {
          result.toolCalls.push(...(data.tool_calls as unknown[]))
        }
        cleanup()
        resolve(result)
      } else if (msgType === 'error') {
        cleanup()
        reject(new Error(`WebSocket error from server: ${data.content ?? 'unknown'}`))
      }
      // Ignore pong and other message types
    })

    ws.on('error', (err: Error) => {
      cleanup()
      reject(err)
    })

    ws.on('close', () => {
      // If we haven't resolved/rejected yet, the connection dropped unexpectedly
      if (timer !== undefined) {
        cleanup()
        reject(new Error('WebSocket closed before receiving a complete response'))
      }
    })
  })
}
