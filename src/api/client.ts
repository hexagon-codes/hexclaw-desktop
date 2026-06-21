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

// ─── HTTP 客户端 (ofetch) ────────────────────────────

/** 创建预配置的 HTTP 客户端 */
export const api = ofetch.create({
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
    const serverMsg = (response._data as Record<string, unknown> | undefined)?.error as string | undefined
    const err = fromHttpStatus(response.status, serverMsg ?? response.statusText)
    logger.error(`API error: [${err.code}] ${err.message}`)
  },
})

// ─── 封装方法 ────────────────────────────────────────

/** GET 请求 */
export function apiGet<T>(url: string, query?: Record<string, unknown>) {
  return api<T>(url, { method: 'GET', query })
}

/** apiPost 可选参数 — 主要给"会触发慢上游"的接口（cron 编译）放宽 timeout */
export interface ApiPostOptions {
  /** 覆盖 env.timeout 默认值，单位 ms */
  timeout?: number
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
    // timeout <= 0 视为无效输入回退 env.timeout，与 JSON 路径行为一致
    const tm = options?.timeout && options.timeout > 0 ? options.timeout : env.timeout
    return uploadFormData<T>(url, body, tm)
  }
  const opts: Record<string, unknown> = { method: 'POST' }
  if (body) opts.body = body as Record<string, unknown>
  if (options?.timeout && options.timeout > 0) opts.timeout = options.timeout
  return api<T>(url, opts)
}

async function uploadFormData<T>(url: string, body: FormData, timeoutMs: number): Promise<T> {
  const fullUrl = `${env.apiBase}${url}`
  logger.debug(`→ POST ${fullUrl} (multipart)`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      body,
      signal: controller.signal,
    })
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
      throw new Error(apiErr.message)
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** PUT 请求 */
export function apiPut<T>(url: string, body?: Record<string, unknown> | object) {
  return api<T>(url, { method: 'PUT', body: body as Record<string, unknown> })
}

/** PATCH 请求 */
export function apiPatch<T>(url: string, body?: Record<string, unknown> | object) {
  return api<T>(url, { method: 'PATCH', body: body as Record<string, unknown> })
}

/** DELETE 请求 */
export function apiDelete<T>(url: string) {
  return api<T>(url, { method: 'DELETE' })
}

// ─── SSE 流式请求 ────────────────────────────────────

/** SSE 流式请求 — 返回 ReadableStream<string> */
export async function apiSSE(
  url: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<string>> {
  logger.debug(`→ SSE POST ${url}`)

  const response = await fetch(`${env.apiBase}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })

  if (!response.ok) {
    const apiErr = fromHttpStatus(response.status)
    throw new Error(apiErr.message)
  }

  if (!response.body) {
    throw new Error('SSE response body is empty')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''

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
          if (done) {
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
  })
}

// ─── WebSocket ───────────────────────────────────────

/** WebSocket 连接 */
export function apiWebSocket(path: string): WebSocket {
  const url = `${env.wsBase}${path}`
  logger.debug(`→ WS ${url}`)
  return new WebSocket(url)
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
