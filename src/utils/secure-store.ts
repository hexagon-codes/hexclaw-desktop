/**
 * 安全存储工具
 *
 * 为 API Key 等敏感数据提供加密存储能力:
 *   - Tauri 桌面环境: 使用 @tauri-apps/plugin-store 存储到独立加密文件
 *   - 浏览器开发环境: 使用 Web Crypto API AES-GCM 加密后存入 localStorage
 *
 * ⚠️ 浏览器降级方案安全等级说明:
 *   浏览器模式下使用固定口令 ('hexclaw-desktop') + 随机 salt 进行 PBKDF2 密钥派生。
 *   salt 存储在 localStorage 中，口令硬编码在源码中。任何能执行 JS 的上下文
 *   （如 XSS 或恶意浏览器扩展）都可以读取 salt 并结合已知口令解密所有值。
 *   因此浏览器模式下的加密本质上是 **混淆 (obfuscation)**，而非真正的安全加密。
 *   生产环境应始终使用 Tauri Store 方案。
 *
 * 使用示例:
 *   await saveSecureValue('llm_api_key', 'sk-abc123...')
 *   const key = await loadSecureValue('llm_api_key')
 */

import { logger } from './logger'

/** localStorage 降级存储的 key 前缀 */
const SECURE_PREFIX = 'hc-sec-'

/** Tauri Store 文件名 */
const STORE_FILE = 'secure.dat'

/** localStorage 中存储设备专属 salt 的 key */
const DEVICE_SALT_KEY = 'hc-device-salt'

// ─── 加密/解密 (浏览器降级方案 — AES-GCM) ─────────────

/**
 * 获取设备专属 salt（首次使用时随机生成并持久化）
 *
 * 每个设备/浏览器有独立的随机 salt，不再使用硬编码值。
 * 注意：这仍然是浏览器降级方案，真正的安全存储应使用 Tauri Store。
 */
function getDeviceSalt(): Uint8Array {
  const existing = localStorage.getItem(DEVICE_SALT_KEY)
  if (existing) {
    return Uint8Array.from(atob(existing), (c) => c.charCodeAt(0))
  }
  const salt = crypto.getRandomValues(new Uint8Array(32))
  localStorage.setItem(DEVICE_SALT_KEY, btoa(String.fromCharCode(...salt)))
  return salt
}

/** 使用 PBKDF2 从设备专属 salt 派生 AES-GCM 密钥 */
async function deriveKey(): Promise<CryptoKey> {
  const salt = getDeviceSalt()
  // 使用固定口令 + 随机 salt：salt 的随机性提供了安全性
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode('hexclaw-desktop'), 'PBKDF2', false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

/** AES-GCM 加密，返回 Base64(IV + ciphertext) */
async function encrypt(value: string): Promise<string> {
  const key = await deriveKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(value),
  )
  // 拼接 IV + 密文并 Base64 编码
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

/** AES-GCM 解密，输入为 Base64(IV + ciphertext) */
async function decrypt(data: string): Promise<string> {
  const key = await deriveKey()
  const combined = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, ciphertext,
  )
  return new TextDecoder().decode(plaintext)
}

// ─── 环境检测 ───────────────────────────────────────────

/** 检测是否运行在 Tauri 桌面环境中（与 @tauri-apps/api/core 保持一致） */
function isTauri(): boolean {
  return !!(globalThis as Record<string, unknown>).isTauri
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

  // Fallback: AES-GCM 加密后存储到 localStorage
  if (typeof localStorage === 'undefined' || !crypto?.subtle) return
  try {
    const encrypted = await encrypt(value)
    localStorage.setItem(`${SECURE_PREFIX}${key}`, encrypted)
    logger.debug(`安全存储: ${key} (localStorage fallback)`)
  } catch (e) {
    logger.warn(`安全存储加密失败: ${key}`, e)
  }
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

  // Fallback: 从 localStorage 读取并解密
  if (typeof localStorage === 'undefined' || !crypto?.subtle) return null
  try {
    const encrypted = localStorage.getItem(`${SECURE_PREFIX}${key}`)
    if (!encrypted) return null
    return await decrypt(encrypted)
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

  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(`${SECURE_PREFIX}${key}`)
    logger.debug(`安全存储: 已删除 ${key} (localStorage fallback)`)
  }
}
