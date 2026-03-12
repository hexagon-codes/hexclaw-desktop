/**
 * API 客户端
 *
 * 统一管理所有 HTTP/SSE/WebSocket 请求。
 * 内置请求拦截（日志 + 错误分类），环境配置驱动。
 */

import { ofetch } from 'ofetch'
import { env } from '@/config/env'
import { fromHttpStatus, fromNativeError, createApiError, type ApiError } from '@/utils/errors'
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
    logger.error(`API 错误: [${err.code}] ${err.message}`)
  },
})

// ─── 封装方法 ────────────────────────────────────────

/** GET 请求 */
export function apiGet<T>(url: string, query?: Record<string, unknown>) {
  return api<T>(url, { method: 'GET', query })
}

/** POST 请求 */
export function apiPost<T>(url: string, body?: Record<string, unknown> | FormData | object) {
  const opts: Record<string, unknown> = { method: 'POST' }
  if (body instanceof FormData) {
    opts.body = body
  } else if (body) {
    opts.body = body as Record<string, unknown>
  }
  return api<T>(url, opts)
}

/** PUT 请求 */
export function apiPut<T>(url: string, body?: Record<string, unknown> | object) {
  return api<T>(url, { method: 'PUT', body: body as Record<string, unknown> })
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
    const err = fromHttpStatus(response.status)
    throw err
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  return new ReadableStream<string>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        const text = decoder.decode(value, { stream: true })
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') {
              controller.close()
              return
            }
            controller.enqueue(data)
          }
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

/** 健康检查 */
export async function checkHealth(): Promise<boolean> {
  try {
    await api('/health', { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// ─── 重新导出错误工具 (方便外部使用) ─────────────────

export type { ApiError }
export { fromNativeError, createApiError, isRetryable, getErrorMessage } from '@/utils/errors'
