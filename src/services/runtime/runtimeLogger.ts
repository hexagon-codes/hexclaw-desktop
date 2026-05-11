/**
 * RuntimeLogger — Runtime Governance 日志抽象
 *
 * 解耦 Runtime 治理逻辑与 console，方便后续切换日志平台。
 * Phase 4 内部委托 console。
 */

export interface RuntimeLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 默认实现 — 委托 console */
class ConsoleRuntimeLogger implements RuntimeLogger {
  info(message: string, ...args: unknown[]): void {
    console.info(`[Runtime] ${message}`, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[Runtime] ${message}`, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[Runtime] ${message}`, ...args)
  }
}

let instance: RuntimeLogger | null = null

export function getRuntimeLogger(): RuntimeLogger {
  if (!instance) {
    instance = new ConsoleRuntimeLogger()
  }
  return instance
}

/** 测试用：替换 logger 实现 */
export function setRuntimeLogger(logger: RuntimeLogger): void {
  instance = logger
}
