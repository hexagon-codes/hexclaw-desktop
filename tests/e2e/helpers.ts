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

export const BASE_URL = (process.env.HEX_E2E_SIDECAR_URL || 'http://localhost:16060').replace(/\/$/, '')
export const WS_URL = process.env.HEX_E2E_SIDECAR_WS_URL
  || `${BASE_URL.replace(/^http/, 'ws')}/ws`
export const USER_ID = 'e2e-playwright'

export function e2eMarker(prefix = 'marker'): string {
  const suffix = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8).padEnd(8, 'x')
  return `${prefix}-${suffix}`
}

export function e2eTextMarker(): string {
  return e2eMarker('mark')
}

function isTransientLLMError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase()
  return /(?:unexpected\s+eof|\beof\b|tls handshake timeout|connection reset|connection refused|socket hang up|temporarily unavailable|timeout awaiting response headers)/.test(msg)
    && /(siliconflow|api\.siliconflow|openai stream request failed|chat\/completions|llm complete|runtime stream)/.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

  // 与 wsChat 同口径：HTTP /chat 默认 routing 走 app 的 llm.default（本机默认本地 provider，
  // 未安装本地 runtime 即 400）。HEX_E2E_PROVIDER / HEX_E2E_MODEL 把真机链路定向到已配置的云端
  // provider 及其模型（body 已显式给的字段优先，不覆盖）。
  let finalBody = body
  if (body !== undefined && path.startsWith('/api/v1/chat')) {
    finalBody = {
      ...(process.env.HEX_E2E_PROVIDER ? { provider: process.env.HEX_E2E_PROVIDER } : {}),
      ...(process.env.HEX_E2E_MODEL ? { model: process.env.HEX_E2E_MODEL } : {}),
      ...body,
    }
  }

  let last: ApiResponse | undefined
  const attempts = path.startsWith('/api/v1/chat') ? 2 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const init: RequestInit = { method, headers }
    if (finalBody !== undefined) {
      init.body = JSON.stringify(finalBody)
    }

    const res = await fetch(url, init)
    const text = await res.text()

    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      data = { raw: text }
    }

    last = { status: res.status, data }
    if (res.status < 500 || attempt === attempts || !isTransientLLMError(JSON.stringify(data))) {
      return last
    }
    await sleep(1_500 * attempt)
  }

  return last!
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
  /** Timeout in milliseconds (default 300 000) */
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
  // 优先使用已配置的 provider/model：默认 routing 走 app 的 llm.default（本机默认是本地 provider，
  // 未安装本地 runtime 时会 400）。HEX_E2E_PROVIDER / HEX_E2E_MODEL 可把真机链路定向到已配置的
  // 云端 provider 及其模型，不改 app 默认配置；显式 options 仍最高优先。
  return wsChatWithRetry(content, options)
}

async function wsChatWithRetry(
  content: string,
  options: WsChatOptions = {},
): Promise<ChatResult> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await wsChatOnce(content, options)
    } catch (err) {
      lastErr = err
      if (attempt === 2 || !isTransientLLMError(err)) {
        throw err
      }
      await sleep(1_500 * attempt)
    }
  }
  throw lastErr
}

function wsChatOnce(
  content: string,
  options: WsChatOptions = {},
): Promise<ChatResult> {
  const {
    sessionId,
    provider = process.env.HEX_E2E_PROVIDER || undefined,
    model = process.env.HEX_E2E_MODEL || undefined,
    metadata,
    timeoutMs = 300_000,
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
