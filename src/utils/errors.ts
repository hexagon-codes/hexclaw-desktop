/**
 * 统一错误处理体系
 *
 * 提供结构化错误分类、用户友好提示、错误恢复建议。
 * 所有 API 调用错误统一通过此模块处理。
 */

import { logger } from './logger'

export type { ApiError, ApiErrorCode } from '@/types/error'
type ApiError = import('@/types/error').ApiError
type ApiErrorCode = import('@/types/error').ApiErrorCode

// ─── 错误构造 ────────────────────────────────────────

/** 创建结构化 API 错误 */
export function createApiError(
  code: ApiErrorCode,
  message: string,
  status?: number,
  cause?: unknown,
): ApiError {
  return { code, message, status, cause }
}

/** 从 HTTP 响应状态码推断错误类型 */
export function fromHttpStatus(status: number, serverMessage?: string): ApiError {
  const map: Record<number, [ApiErrorCode, string]> = {
    401: ['UNAUTHORIZED', '未授权，请检查认证配置'],
    403: ['FORBIDDEN', '无权执行此操作'],
    404: ['NOT_FOUND', '请求的资源不存在'],
    422: ['VALIDATION_ERROR', serverMessage || '请求参数校验失败'],
    429: ['RATE_LIMITED', '请求过于频繁，请稍后重试'],
  }

  const entry = map[status]
  if (entry) return createApiError(entry[0], entry[1], status)

  if (status >= 500) {
    return createApiError('SERVER_ERROR', serverMessage || '服务器内部错误', status)
  }

  return createApiError('UNKNOWN', serverMessage || `请求失败 (${status})`, status)
}

/** 从原生错误推断类型 */
export function fromNativeError(err: unknown): ApiError {
  // 已经是 ApiError 结构
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const ae = err as ApiError
    if (typeof ae.message === 'string') return ae
  }
  if (err instanceof TypeError && err.message.includes('fetch')) {
    return createApiError('NETWORK_ERROR', 'HexClaw 服务未启动或网络不可达', undefined, err)
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return createApiError('TIMEOUT', '请求超时', undefined, err)
  }
  if (err instanceof Error) {
    // ofetch 的 FetchError 包含 status
    const fetchErr = err as Error & { status?: number; statusCode?: number; data?: { error?: string } }
    const status = fetchErr.status ?? fetchErr.statusCode
    if (status) {
      return fromHttpStatus(status, fetchErr.data?.error ?? err.message)
    }
    return createApiError('UNKNOWN', err.message, undefined, err)
  }
  const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : '未知错误')
  return createApiError('UNKNOWN', msg, undefined, err)
}

// ─── 错误处理工具 ────────────────────────────────────

/** 安全执行异步操作，返回 [data, null] 或 [null, error] */
export async function trySafe<T>(
  fn: () => Promise<T>,
  context?: string,
): Promise<[T, null] | [null, ApiError]> {
  try {
    const data = await fn()
    return [data, null]
  } catch (err) {
    const apiErr = fromNativeError(err)
    logger.error(`${context ?? 'API'} 失败: [${apiErr.code}] ${apiErr.message}`, err)
    return [null, apiErr]
  }
}

/** 判断是否为网络错误（可重试） */
export function isRetryable(err: ApiError): boolean {
  return ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'RATE_LIMITED'].includes(err.code)
}

/** 获取用户友好的错误提示 */
export function getErrorMessage(err: ApiError): string {
  return err.message
}
