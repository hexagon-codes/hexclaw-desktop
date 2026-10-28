/**
 * Shared E2E test utilities for HexClaw Playwright tests.
 *
 * NOTE: This module uses the `ws` npm package for WebSocket.
 * If not already installed, run:
 *   pnpm add -D ws @types/ws
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASE_URL = (process.env.HEX_E2E_SIDECAR_URL || 'http://localhost:16060').replace(/\/$/, '')
export const WS_URL = process.env.HEX_E2E_SIDECAR_WS_URL
  || `${BASE_URL.replace(/^http/, 'ws')}/ws`
export const USER_ID = process.env.HEX_E2E_USER_ID?.trim() || 'api-user'

export function e2eMarker(prefix = 'marker'): string {
  const suffix = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8).padEnd(8, 'x')
  return `${prefix}-${suffix}`
}

export function e2eTextMarker(): string {
  return e2eMarker('mark')
}

// 复用真实 Sidecar 的能力令牌环境，不在测试中保存或输出凭据。
function sidecarAuthorization(): Record<string, string> {
  const token = process.env.HEXCLAW_SIDECAR_CAPABILITY_TOKEN?.trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function chatRequestId(value?: unknown): string {
  return typeof value === 'string' && value.trim() ? value : `e2e-${randomUUID()}`
}

// 只记录协议身份与实际模型元数据，不保存提示词、正文、令牌或认证头。
function recordChatEvidence(protocol: 'http' | 'ws', requestId: string, status: string | number, metadata: Record<string, unknown> = {}) {
  const path = process.env.HEX_E2E_EVIDENCE_PATH
  if (!path) return
  appendFileSync(path, JSON.stringify({
    time: new Date().toISOString(), protocol, request_id: requestId, status,
    provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
    model: typeof metadata.model === 'string' ? metadata.model : undefined,
    session_id: typeof metadata.session_id === 'string' ? metadata.session_id : undefined,
  }) + '\n', { mode: 0o600 })
}

// 传输结束不代表业务未执行；保留原请求身份供查询，绝不自动重发。
export class E2ERequestError extends Error {
  readonly requestId?: string

  constructor(message: string, requestId?: string) {
    super(requestId ? `${message}; request_id=${requestId}; query the original result before resending` : message)
    this.name = 'E2ERequestError'
    this.requestId = requestId
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ApiResponse {
  status: number
  requestId?: string
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
    ...sidecarAuthorization(),
  }

  // 与 wsChat 同口径：HTTP /chat 默认 routing 走 app 的 llm.default（本机默认本地 provider，
  // 未安装本地 runtime 即 400）。HEX_E2E_PROVIDER / HEX_E2E_MODEL 把真机链路定向到已配置的云端
  // provider 及其模型（body 已显式给的字段优先，不覆盖）。
  let finalBody = body
  let requestId: string | undefined
  if (body !== undefined && path.startsWith('/api/v1/chat')) {
    const metadata = body.metadata as Record<string, unknown> | undefined
    requestId = chatRequestId(body.request_id ?? metadata?.request_id)
    finalBody = {
      ...(process.env.HEX_E2E_PROVIDER ? { provider: process.env.HEX_E2E_PROVIDER } : {}),
      ...(process.env.HEX_E2E_MODEL ? { model: process.env.HEX_E2E_MODEL } : {}),
      ...(!('user_id' in body) ? { user_id: USER_ID } : {}),
      ...body,
      request_id: requestId,
    }
  }

  try {
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

    if (requestId) {
      const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : {}
      recordChatEvidence('http', requestId, res.status, { ...metadata, session_id: data.session_id })
    }
    return { status: res.status, data, requestId }
  } catch {
    throw new E2ERequestError(`${method} ${new URL(url).pathname} failed before a complete response (detail redacted)`, requestId)
  }
}

// ---------------------------------------------------------------------------
// WebSocket chat helper
// ---------------------------------------------------------------------------

export interface ChatResult {
  /** 本次单次请求发送的稳定身份，失败时也保留。 */
  requestId: string
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
  requestId?: string
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
  return wsChatOnce(content, options)
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
  const requestId = chatRequestId(options.requestId ?? metadata?.request_id)

  return new Promise<ChatResult>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: sidecarAuthorization() })

    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const result: ChatResult = {
      requestId,
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

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      try { recordChatEvidence('ws', requestId, 'failed', result.metadata) } catch { message += '; evidence recording failed' }
      reject(new E2ERequestError(message, requestId))
    }

    const complete = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        recordChatEvidence('ws', requestId, 'succeeded', result.metadata)
      } catch {
        reject(new E2ERequestError('Response completed but evidence recording failed', requestId))
        return
      }
      resolve(result)
    }

    // Timeout guard
    timer = setTimeout(() => {
      fail(`wsChat timed out after ${timeoutMs}ms`)
    }, timeoutMs)

    ws.on('open', () => {
      const msg: Record<string, unknown> = {
        type: 'message',
        content,
        user_id: USER_ID,
        request_id: requestId,
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
          complete()
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
        complete()
      } else if (msgType === 'error') {
        fail(`WebSocket error from server: ${data.content ?? 'unknown'}`)
      }
      // Ignore pong and other message types
    })

    ws.on('error', (err: Error) => {
      fail(err.message)
    })

    ws.on('close', () => {
      // If we haven't resolved/rejected yet, the connection dropped unexpectedly
      if (!settled) {
        fail('WebSocket closed before receiving a complete response')
      }
    })
  })
}
