/**
 * 结构化日志
 *
 * 生产级日志：级别过滤 + 时间戳 + 结构化字段。
 * 开发模式下输出到 console，可扩展为写入文件或远程上报。
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getMinLevel(): LogLevel {
  if (import.meta.env?.MODE === 'test' || import.meta.env?.VITEST) return 'warn'
  // 延迟读取，避免循环依赖
  try {
    const envVal = import.meta.env.VITE_LOG_LEVEL as string | undefined
    if (envVal && envVal in LEVEL_ORDER) return envVal as LogLevel
  } catch {
    // 非 Vite 环境 (测试等) 忽略
  }
  return import.meta.env?.DEV ? 'debug' : 'warn'
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getMinLevel()]
}

function formatTime(): string {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
}

function formatLog(level: LogLevel, msg: string): string {
  return `[${formatTime()}] [${level.toUpperCase().padEnd(5)}] ${msg}`
}

class Logger {
  debug(msg: string, ...extra: unknown[]) {
    if (shouldLog('debug')) console.debug(formatLog('debug', msg), ...extra)
  }

  info(msg: string, ...extra: unknown[]) {
    if (shouldLog('info')) console.info(formatLog('info', msg), ...extra)
  }

  warn(msg: string, ...extra: unknown[]) {
    if (shouldLog('warn')) console.warn(formatLog('warn', msg), ...extra)
  }

  error(msg: string, ...extra: unknown[]) {
    if (shouldLog('error')) console.error(formatLog('error', msg), ...extra)
  }
}

/** 全局 logger 单例 */
export const logger = new Logger()
