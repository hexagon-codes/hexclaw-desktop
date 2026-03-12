/**
 * 安全存储工具
 *
 * 为 API Key 等敏感数据提供加密存储能力:
 *   - Tauri 桌面环境: 使用 @tauri-apps/plugin-store 存储到独立加密文件
 *   - 浏览器开发环境: 降级为 Base64 编码存入 localStorage (非加密，仅防止明文暴露)
 *
 * 使用示例:
 *   await saveSecureValue('llm_api_key', 'sk-abc123...')
 *   const key = await loadSecureValue('llm_api_key')
 */

import { logger } from './logger'

/** localStorage 降级存储的 key 前缀 */
const SECURE_PREFIX = 'hc-secure-'

/** Tauri Store 文件名 */
const STORE_FILE = 'secure.dat'

// ─── 编码/解码 (浏览器降级方案) ─────────────────────────

/** Base64 编码 — 仅用于浏览器开发模式，避免明文存储 */
function encode(value: string): string {
  return btoa(encodeURIComponent(value))
}

/** Base64 解码 */
function decode(value: string): string {
  return decodeURIComponent(atob(value))
}

// ─── 环境检测 ───────────────────────────────────────────

/** 检测是否运行在 Tauri 桌面环境中 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

// ─── 公开 API ───────────────────────────────────────────

/**
 * 安全存储一个值
 *
 * @param key   存储键名
 * @param value 要存储的敏感值 (如 API Key)
 */
export async function saveSecureValue(key: string, value: string): Promise<void> {
  if (isTauri()) {
    try {
      const { LazyStore } = await import('@tauri-apps/plugin-store')
      const store = new LazyStore(STORE_FILE)
      await store.set(key, value)
      await store.save()
      logger.debug(`安全存储: ${key} (Tauri Store)`)
      return
    } catch (e) {
      logger.warn('Tauri Store 不可用，降级到 localStorage', e)
    }
  }

  // Fallback: Base64 编码存储到 localStorage
  localStorage.setItem(`${SECURE_PREFIX}${key}`, encode(value))
  logger.debug(`安全存储: ${key} (localStorage fallback)`)
}

/**
 * 读取安全存储的值
 *
 * @param key 存储键名
 * @returns   存储的值，不存在时返回 null
 */
export async function loadSecureValue(key: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const { LazyStore } = await import('@tauri-apps/plugin-store')
      const store = new LazyStore(STORE_FILE)
      const value = await store.get<string>(key)
      return value ?? null
    } catch (e) {
      logger.warn('Tauri Store 读取失败，降级到 localStorage', e)
    }
  }

  // Fallback: 从 localStorage 读取并解码
  const encoded = localStorage.getItem(`${SECURE_PREFIX}${key}`)
  if (!encoded) return null
  try {
    return decode(encoded)
  } catch {
    return null
  }
}

/**
 * 删除安全存储的值
 *
 * @param key 存储键名
 */
export async function removeSecureValue(key: string): Promise<void> {
  if (isTauri()) {
    try {
      const { LazyStore } = await import('@tauri-apps/plugin-store')
      const store = new LazyStore(STORE_FILE)
      await store.delete(key)
      await store.save()
      logger.debug(`安全存储: 已删除 ${key} (Tauri Store)`)
      return
    } catch {
      // 降级到 localStorage
    }
  }

  localStorage.removeItem(`${SECURE_PREFIX}${key}`)
  logger.debug(`安全存储: 已删除 ${key} (localStorage fallback)`)
}
