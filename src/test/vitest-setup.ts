/**
 * Vitest 全局 setup：仅在 localStorage 不完整时注入内存实现。
 * 若直接使用完整 polyfill，会绕过 Storage.prototype，导致 persist / useTheme 等
 * 依赖 vi.spyOn(Storage.prototype, ...) 的用例失败。
 */
import { beforeEach } from 'vitest'

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null
    },
    removeItem(key: string) {
      map.delete(key)
    },
    setItem(key: string, value: string) {
      map.set(key, value)
    },
  }
}

function localStorageBroken(): boolean {
  try {
    const ls = globalThis.localStorage
    if (ls == null) return true
    if (typeof ls.getItem !== 'function') return true
    if (typeof ls.setItem !== 'function') return true
    if (typeof ls.clear !== 'function') return true
    if (typeof ls.removeItem !== 'function') return true
    return false
  } catch {
    return true
  }
}

if (localStorageBroken()) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  })
}

if (typeof globalThis.sessionStorage === 'undefined' || (() => {
  try {
    const s = globalThis.sessionStorage
    return s == null || typeof s.getItem !== 'function'
  } catch {
    return true
  }
})()) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  try {
    globalThis.localStorage?.clear?.()
  } catch {
    /* ignore */
  }
  try {
    globalThis.sessionStorage?.clear?.()
  } catch {
    /* ignore */
  }
})
