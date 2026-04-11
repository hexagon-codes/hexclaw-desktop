/**
 * 安全存储工具
 *
 * 为 API Key 等敏感数据提供加密存储能力:
 *   - Tauri 桌面环境: 使用 @tauri-apps/plugin-store 存储到独立文件
 *   - 浏览器开发环境: 仅保存在当前 renderer 进程内存中，不做本地持久化
 *
 * ⚠️ 浏览器模式安全边界说明:
 *   浏览器上下文无法把 localStorage / sessionStorage 当成可信 secret storage。
 *   因此这里选择 fail-closed：浏览器模式下不再持久化敏感信息，只保留当前页面生命周期内
 *   的临时值。页面刷新或重开后，调用方需要重新输入 API Key。
 *
 * 使用示例:
 *   await saveSecureValue('llm_api_key', 'sk-abc123...')
 *   const key = await loadSecureValue('llm_api_key')
 */

import { logger } from './logger'
import { isTauri } from './platform'

/** Tauri Store 文件名 */
const STORE_FILE = 'secure.dat'

/** legacy localStorage key prefix from the old browser fallback */
const LEGACY_SECURE_PREFIX = 'hc-sec-'

/** 当前 renderer 进程内的短时敏感值缓存（浏览器模式） */
const volatileBrowserStore = new Map<string, string>()
let warnedAboutBrowserFallback = false

function warnBrowserFallbackOnce() {
  if (warnedAboutBrowserFallback) return
  warnedAboutBrowserFallback = true
  logger.warn('浏览器模式下不持久化敏感信息；API Key 仅保留在当前页面内存中。')
}

function clearLegacyLocalStorageKey(key: string) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(`${LEGACY_SECURE_PREFIX}${key}`)
  } catch {
    // ignore legacy cleanup failure
  }
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
      logger.warn('Tauri Store 不可用，降级到当前页面内存', e)
    }
  }

  warnBrowserFallbackOnce()
  clearLegacyLocalStorageKey(key)
  volatileBrowserStore.set(key, value)
  logger.debug(`安全存储: ${key} (volatile browser fallback)`)
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
      logger.warn('Tauri Store 读取失败，降级到当前页面内存', e)
    }
  }

  if (volatileBrowserStore.has(key)) {
    return volatileBrowserStore.get(key) ?? null
  }
  clearLegacyLocalStorageKey(key)
  return null
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
      // 降级到当前页面内存
    }
  }

  volatileBrowserStore.delete(key)
  clearLegacyLocalStorageKey(key)
  logger.debug(`安全存储: 已删除 ${key} (volatile browser fallback)`)
}
