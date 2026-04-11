/**
 * 环境变量配置
 *
 * 统一管理所有环境变量，提供类型安全的访问和运行时校验。
 * 构建时通过 VITE_ 前缀注入，运行时通过 import.meta.env 读取。
 */

function isTauriRuntime(): boolean {
  return !!(globalThis as Record<string, unknown>).isTauri
}

const LEGACY_LOCAL_API_BASES = new Set([
  'http://localhost:16060',
  'http://localhost:16060',
])

const LEGACY_LOCAL_WS_BASES = new Set([
  'ws://localhost:16060',
  'ws://127.0.0.1:16060',
])

function resolveDevProxyBase(): string | null {
  if (import.meta.env.PROD || isTauriRuntime()) return null
  if (typeof window === 'undefined') return null
  const origin = window.location?.origin
  if (!origin || !/^https?:\/\//.test(origin)) return null
  return `${origin.replace(/\/+$/, '')}/_hexclaw`
}

function normalizeLocalApiBase(base: string): string {
  const normalized = base.replace(/\/+$/, '')
  if (!LEGACY_LOCAL_API_BASES.has(normalized)) return normalized
  return resolveDevProxyBase() ?? 'http://localhost:16060'
}

function normalizeLocalWsBase(base: string): string {
  const normalized = base.replace(/\/+$/, '')
  if (!LEGACY_LOCAL_WS_BASES.has(normalized)) return normalized
  return (resolveDevProxyBase() ?? 'http://localhost:16060').replace(/^http/, 'ws')
}

/** Ollama 本地服务地址（与 CSP connect-src 保持一致，统一用 localhost） */
export const OLLAMA_BASE = 'http://localhost:11434'

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
  if (envVal) return normalizeLocalApiBase(envVal)
  const devProxyBase = resolveDevProxyBase()
  if (devProxyBase) return devProxyBase
  return 'http://localhost:16060'
}

function resolveWsBase(apiBase: string): string {
  const envVal = import.meta.env.VITE_WS_BASE as string | undefined
  if (envVal) return normalizeLocalWsBase(envVal)
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
