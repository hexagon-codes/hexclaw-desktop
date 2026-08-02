/**
 * API 客户端
 *
 * 统一管理所有 HTTP/SSE/WebSocket 请求。
 * 内置请求拦截（日志 + 错误分类），环境配置驱动。
 */

import { ofetch } from 'ofetch'
import { env } from '@/config/env'
import { fromHttpStatus, fromNativeError, type ApiError } from '@/utils/errors'
import { logger } from '@/utils/logger'
import { isTauri } from '@/utils/platform'
import { NativeSidecarWebSocket } from './native-sidecar-websocket'
import { sidecarStreamFetch } from './native-sidecar-stream'

interface NativeSidecarFetchResponse {
  status: number
  headers: Record<string, string>
  body: number[]
}

function managedSidecarPath(input: RequestInfo | URL): string | null {
  const raw = input instanceof Request ? input.url : input.toString()
  const url = new URL(raw, env.apiBase)
  const base = new URL(env.apiBase)
  if (url.origin !== base.origin || url.username || url.password || url.hash) return null
  return `${url.pathname}${url.search}`
}

/**
 * Production Desktop transport: the WebView supplies only an HTTP shape and
 * relative path. Rust resolves the managed port and attaches the process-only
 * Sidecar bearer; the capability never enters renderer memory.
 */
export async function sidecarFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const path = managedSidecarPath(input)
  if (!isTauri() || !path) return globalThis.fetch(input, init)

  const managedUrl = new URL(path, env.apiBase)
  const request = new Request(input instanceof Request ? input : managedUrl.toString(), init)
  if (request.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    headers[name] = value
  })
  const body = ['GET', 'HEAD'].includes(request.method)
    ? []
    : Array.from(new Uint8Array(await request.arrayBuffer()))
  if (request.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  const { Channel, invoke } = await import('@tauri-apps/api/core')
  const cancellationId = `sidecar-fetch:${globalThis.crypto.randomUUID()}`
  let registered = false
  let cancellationPending = false
  const cancelNative = () => {
    if (!registered) {
      cancellationPending = true
      return
    }
    void invoke('sidecar_fetch_cancel', { cancellationId }).catch(() => undefined)
  }
  const onRegistered = new Channel<null>(() => {
    registered = true
    if (cancellationPending) cancelNative()
  })
  request.signal.addEventListener('abort', cancelNative, { once: true })
  try {
    const response = await invoke<NativeSidecarFetchResponse>('sidecar_fetch', {
      method: request.method,
      path,
      headers,
      body,
      cancellationId,
      onRegistered,
    })
    if (request.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    })
  } catch (error) {
    if (request.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    throw error
  } finally {
    request.signal.removeEventListener('abort', cancelNative)
  }
}

// ─── HTTP 客户端 (ofetch) ────────────────────────────

/** 创建预配置的 HTTP 客户端 */
export const api = ofetch.create(
  {
    baseURL: env.apiBase,
    timeout: env.timeout,
    headers: {
      'Content-Type': 'application/json',
    },
    onRequest({ request, options }) {
      logger.debug(`→ ${(options.method ?? 'GET').toString().toUpperCase()} ${request.toString()}`)
    },
    onResponse({ request, response, options }) {
      logger.debug(
        `← ${response.status} ${(options.method ?? 'GET').toString().toUpperCase()} ${request.toString()}`,
      )
    },
    onResponseError({ response }) {
      const serverMsg = (response._data as Record<string, unknown> | undefined)?.error as
        | string
        | undefined
      const err = fromHttpStatus(response.status, serverMsg ?? response.statusText)
      logger.error(`API error: [${err.code}] ${err.message}`)
    },
  },
  { fetch: sidecarFetch },
)

// ─── 封装方法 ────────────────────────────────────────

/**
 * normalizeApiError（FS-5）：ofetch 抛出的 FetchError.message 是
 * `[POST] "url": 400 Bad Request`，组件用 e.message 弹 toast 就永远看不到后端
 * 中文错误。这里把已解析的 body.error/body.message 提到 e.message（保留 status/
 * data 等结构不变），让所有经封装方法的调用点拿到人话错误。
 */
function normalizeApiError(e: unknown): unknown {
  const fe = e as { data?: Record<string, unknown> } | null
  const body = fe?.data
  const detail = (body?.error ?? body?.message) as unknown
  if (typeof detail === 'string' && detail.length > 0 && e instanceof Error) {
    e.message = detail
  }
  return e
}

async function withNormalizedError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    throw normalizeApiError(e)
  }
}

export interface ApiGetOptions {
  timeout?: number | false
  signal?: AbortSignal
}

/** GET 请求；轮询类调用可透传 AbortSignal，离开页面时立即释放在途连接。 */
export function apiGet<T>(url: string, query?: Record<string, unknown>, options?: ApiGetOptions) {
  const opts: Record<string, unknown> = { method: 'GET', query }
  if (options?.timeout === false) opts.timeout = 0
  else if (options?.timeout && options.timeout > 0) opts.timeout = options.timeout
  if (options?.signal) opts.signal = options.signal
  return withNormalizedError(api<T>(url, opts))
}

/** apiPost 可选参数 — 主要给"会触发慢上游"的接口（cron 编译）放宽 timeout */
export interface ApiPostOptions {
  /** 覆盖 env.timeout 默认值，单位 ms；false 表示由调用方 AbortSignal/请求生命周期负责取消。 */
  timeout?: number | false
  /** 可取消：调用方 AbortController.signal，用于用户主动取消慢操作（如再练出题·BUG-20260712）。 */
  signal?: AbortSignal
  /** Additional request headers (for example Idempotency-Key on durable creates). */
  headers?: Record<string, string>
  /** Optional exact success status for protocol-bound commands such as async creates. */
  expectedStatus?: number
}

/** POST 请求 */
export function apiPost<T>(
  url: string,
  body?: Record<string, unknown> | FormData | object,
  options?: ApiPostOptions,
): Promise<T> {
  // FormData 上传必须让浏览器自动加 `Content-Type: multipart/form-data; boundary=xxx`，
  // 不能用 ofetch 默认的 `Content-Type: application/json`（boundary 缺失 server 解析失败）。
  // ofetch headers 是 merge 不是 override，无法可靠地"删除"默认 Content-Type，
  // 故 FormData 分支直接用原生 fetch 绕开。
  if (body instanceof FormData) {
    const tm =
      options?.timeout === false
        ? false
        : options?.timeout && options.timeout > 0
          ? options.timeout
          : env.timeout
    return uploadFormData<T>(
      url,
      body,
      tm,
      options?.signal,
      options?.headers,
      options?.expectedStatus,
    )
  }
  const opts: Record<string, unknown> = { method: 'POST' }
  if (body) opts.body = body as Record<string, unknown>
  if (options?.timeout === false) opts.timeout = 0
  else if (options?.timeout && options.timeout > 0) opts.timeout = options.timeout
  if (options?.signal) opts.signal = options.signal // 透传取消信号（ofetch 支持）
  if (options?.headers) opts.headers = options.headers
  return withNormalizedError(api<T>(url, opts))
}

async function uploadFormData<T>(
  url: string,
  body: FormData,
  timeoutMs: number | false,
  callerSignal?: AbortSignal,
  headers?: Record<string, string>,
  expectedStatus?: number,
): Promise<T> {
  const fullUrl = `${env.apiBase}${url}`
  logger.debug(`→ POST ${fullUrl} (multipart)`)
  const controller = new AbortController()
  const timer = timeoutMs === false ? null : setTimeout(() => controller.abort(), timeoutMs)
  // BUG-20260718（§15）：透传调用方 AbortSignal——拍照/教材/作品「取消」必须真正中止上传，
  // 而非只受内部 timeout 支配（旧代码忽略 caller signal → 取消后仍继续上传并写对象）。
  const onCallerAbort = () => controller.abort((callerSignal as AbortSignal | undefined)?.reason)
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }
  try {
    const requestInit: RequestInit = {
      method: 'POST',
      body,
      signal: controller.signal,
    }
    if (headers) requestInit.headers = headers
    const response = await sidecarFetch(fullUrl, requestInit)
    logger.debug(`← ${response.status} POST ${fullUrl}`)
    if (!response.ok) {
      // 与 ofetch onResponseError 对齐：优先抽取 server body.error 字段（不只 statusText）
      let serverMsg = response.statusText
      try {
        const data = (await response.clone().json()) as Record<string, unknown>
        const detail = (data?.error ?? data?.message) as string | undefined
        if (typeof detail === 'string' && detail.length > 0) serverMsg = detail
      } catch {
        // 非 JSON body 时降级用 statusText（不让 SyntaxError 覆盖原 HTTP 状态）
      }
      const apiErr = fromHttpStatus(response.status, serverMsg)
      logger.error(`upload error: [${apiErr.code}] ${apiErr.message}`)
      // 保留 status/code：否则下游 isKnowledgeUploadEndpointMissing 拿不到 rawStatus，
      // 非 JSON 404 的 message="Not Found" 又不匹配关键词 → 端点缺失检测 miss（契约#9）。
      const err = new Error(apiErr.message) as Error & { status?: number; code?: string }
      err.status = response.status
      err.code = apiErr.code
      throw err
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new Error('Invalid response')
    }
    return (await response.json()) as T
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

/** PUT 请求 */
export function apiPut<T>(url: string, body?: Record<string, unknown> | object) {
  return withNormalizedError(api<T>(url, { method: 'PUT', body: body as Record<string, unknown> }))
}

/** PATCH 请求 */
export function apiPatch<T>(url: string, body?: Record<string, unknown> | object) {
  return withNormalizedError(
    api<T>(url, { method: 'PATCH', body: body as Record<string, unknown> }),
  )
}

/** DELETE 请求 */
export function apiDelete<T>(url: string) {
  return withNormalizedError(api<T>(url, { method: 'DELETE' }))
}

// ─── SSE 流式请求 ────────────────────────────────────

/** SSE 流式请求 — 返回 ReadableStream<string> */
export async function apiSSE(
  url: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<string>> {
  logger.debug(`→ SSE POST ${url}`)

  const response = await sidecarStreamFetch(`${env.apiBase}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })

  if (!response.ok) {
    // FS-5 一致性：SSE 错误也优先抽后端 body.error（cron 创建走 SSE，429/400 时
    // 用户应看到后端中文错误而非泛化状态串），与 apiPost/uploadFormData 对齐。
    let serverMsg: string | undefined
    try {
      const data = (await response.clone().json()) as Record<string, unknown>
      const detail = (data?.error ?? data?.message) as string | undefined
      if (typeof detail === 'string' && detail.length > 0) serverMsg = detail
    } catch {
      // 非 JSON body（SSE 端点异常时可能返回纯文本）→ 降级用状态串
    }
    const apiErr = fromHttpStatus(response.status, serverMsg)
    throw new Error(apiErr.message)
  }

  if (!response.body) {
    throw new Error('SSE response body is empty')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let wrapperCancelled = false
  let nativeReleased = false
  const releaseNative = async (reason?: unknown) => {
    if (nativeReleased) return
    nativeReleased = true
    await reader.cancel(reason).catch(() => undefined)
  }

  // 解析单行 SSE：剥除 CRLF 的尾随 \r（SSE 规范允许 \r\n），匹配 data: / [DONE]。
  const handleLine = (
    raw: string,
    controller: ReadableStreamDefaultController<string>,
  ): 'done' | 'enqueued' | 'skip' => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.startsWith('data: ')) return 'skip'
    const data = line.slice(6)
    if (data === '[DONE]') return 'done'
    controller.enqueue(data)
    return 'enqueued'
  }

  return new ReadableStream<string>({
    async pull(controller) {
      try {
        // 单次 pull 内持续读，直到产出 ≥1 条 data、遇 [DONE] 或 done 收尾。
        // 不能在「只读到半行、无产出」时直接 return —— 那会依赖 stream 再次 pull 的语义，
        // 部分实现（jsdom）下消费者 read() 会永久挂起。
        while (true) {
          const { done, value } = await reader.read()
          if (wrapperCancelled) return
          if (done) {
            nativeReleased = true
            // flush 末行：最后一条 data 可能未以 \n 结尾，done 时残留在 lineBuffer，
            // 不补处理会被静默丢弃。
            const tail = lineBuffer
            lineBuffer = ''
            if (tail) handleLine(tail, controller)
            controller.close()
            return
          }
          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() || '' // 最后一段可能是不完整行，保留到下次
          let produced = false
          for (const line of lines) {
            const r = handleLine(line, controller)
            if (r === 'done') {
              await releaseNative()
              controller.close()
              return
            }
            if (r === 'enqueued') produced = true
          }
          if (produced) return // 有产出即交还消费者；下次 read() 触发新的 pull
        }
      } catch (err) {
        const apiErr = fromNativeError(err)
        controller.error(apiErr)
      }
    },
    cancel(reason) {
      wrapperCancelled = true
      lineBuffer = ''
      return releaseNative(reason)
    },
  })
}

// ─── WebSocket ───────────────────────────────────────

/** WebSocket 连接 */
export function apiWebSocket(path: string): NativeSidecarWebSocket {
  logger.debug(`→ WS ${path}`)
  return new NativeSidecarWebSocket(path)
}

// ─── 健康检查 ────────────────────────────────────────

/** 健康检查（通过 Tauri command 绕过 CORS，回退到 HTTP） */
export async function checkHealth(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<boolean>('check_engine_health')
    return Boolean(result)
  } catch {
    try {
      await api('/health', { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }
}

// ─── 重新导出错误工具 (方便外部使用) ─────────────────

export type { ApiError }
export { fromNativeError, createApiError, isRetryable, getErrorMessage } from '@/utils/errors'
