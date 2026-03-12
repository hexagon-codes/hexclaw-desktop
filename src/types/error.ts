/** API 错误码 */
export type ApiErrorCode =
  | 'NETWORK_ERROR'       // 网络不可达
  | 'TIMEOUT'             // 请求超时
  | 'UNAUTHORIZED'        // 未授权 (401)
  | 'FORBIDDEN'           // 禁止访问 (403)
  | 'NOT_FOUND'           // 资源不存在 (404)
  | 'VALIDATION_ERROR'    // 请求参数校验失败 (422)
  | 'RATE_LIMITED'        // 请求被限流 (429)
  | 'SERVER_ERROR'        // 服务端错误 (500+)
  | 'SSE_PARSE_ERROR'     // SSE 流解析失败
  | 'UNKNOWN'             // 未知错误

/** 结构化 API 错误 */
export interface ApiError {
  /** 错误码 */
  code: ApiErrorCode
  /** 用户可读的错误信息 */
  message: string
  /** HTTP 状态码 (如有) */
  status?: number
  /** 原始错误 */
  cause?: unknown
}
