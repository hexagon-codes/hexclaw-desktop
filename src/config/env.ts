/**
 * 环境变量配置
 *
 * 统一管理所有环境变量，提供类型安全的访问和运行时校验。
 * 构建时通过 VITE_ 前缀注入，运行时通过 import.meta.env 读取。
 */

/** 环境配置 */
export interface EnvConfig {
  /** hexclaw 后端 API 基础地址 */
  apiBase: string
  /** WebSocket 基础地址 */
  wsBase: string
  /** 是否为开发模式 */
  isDev: boolean
  /** 请求超时 (ms) */
  timeout: number
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

function resolveApiBase(): string {
  const envVal = import.meta.env.VITE_API_BASE as string | undefined
  if (envVal) return envVal.replace(/\/+$/, '')
  return 'http://localhost:16060'
}

function resolveWsBase(apiBase: string): string {
  const envVal = import.meta.env.VITE_WS_BASE as string | undefined
  if (envVal) return envVal.replace(/\/+$/, '')
  // 从 HTTP 地址自动推导 WS 地址
  return apiBase.replace(/^http/, 'ws')
}

function resolveTimeout(): number {
  const envVal = import.meta.env.VITE_API_TIMEOUT as string | undefined
  if (envVal) {
    const n = Number(envVal)
    if (!Number.isNaN(n) && n > 0) return n
  }
  return 30_000
}

function resolveLogLevel(): EnvConfig['logLevel'] {
  const envVal = import.meta.env.VITE_LOG_LEVEL as string | undefined
  const valid = ['debug', 'info', 'warn', 'error'] as const
  if (envVal && (valid as readonly string[]).includes(envVal)) {
    return envVal as EnvConfig['logLevel']
  }
  return import.meta.env.DEV ? 'debug' : 'warn'
}

const apiBase = resolveApiBase()

/** 全局环境配置（只读单例） */
export const env: Readonly<EnvConfig> = Object.freeze({
  apiBase,
  wsBase: resolveWsBase(apiBase),
  isDev: import.meta.env.DEV === true,
  timeout: resolveTimeout(),
  logLevel: resolveLogLevel(),
})
