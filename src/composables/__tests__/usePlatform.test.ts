/**
 * usePlatform 测试
 *
 * 验证平台检测逻辑和 composable 返回值
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// We need to control navigator.userAgent before the module is imported,
// so we use dynamic imports with vi.resetModules() between tests.

const originalUA = navigator.userAgent

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}

function restoreUserAgent() {
  Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true })
}

describe('detectPlatform', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    restoreUserAgent()
  })

  it('returns macos for Mac user agent', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    const { usePlatform } = await import('../usePlatform')
    expect(usePlatform().platform.value).toBe('macos')
  })

  it('returns macos for Darwin user agent', async () => {
    setUserAgent('Mozilla/5.0 (Darwin; x86_64)')
    const { usePlatform } = await import('../usePlatform')
    expect(usePlatform().platform.value).toBe('macos')
  })

  it('returns windows for Windows user agent', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    const { usePlatform } = await import('../usePlatform')
    expect(usePlatform().platform.value).toBe('windows')
  })

  it('returns linux for Linux user agent', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    const { usePlatform } = await import('../usePlatform')
    expect(usePlatform().platform.value).toBe('linux')
  })

  it('returns linux for unknown user agent (fallback)', async () => {
    setUserAgent('SomeUnknownAgent/1.0')
    const { usePlatform } = await import('../usePlatform')
    expect(usePlatform().platform.value).toBe('linux')
  })
})

describe('usePlatform boolean flags', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    restoreUserAgent()
  })

  it('isMac is true, others false on macOS', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    const { usePlatform } = await import('../usePlatform')
    const { isMac, isWindows, isLinux } = usePlatform()
    expect(isMac).toBe(true)
    expect(isWindows).toBe(false)
    expect(isLinux).toBe(false)
  })

  it('isWindows is true, others false on Windows', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const { usePlatform } = await import('../usePlatform')
    const { isMac, isWindows, isLinux } = usePlatform()
    expect(isMac).toBe(false)
    expect(isWindows).toBe(true)
    expect(isLinux).toBe(false)
  })

  it('isLinux is true, others false on Linux', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    const { usePlatform } = await import('../usePlatform')
    const { isMac, isWindows, isLinux } = usePlatform()
    expect(isMac).toBe(false)
    expect(isWindows).toBe(false)
    expect(isLinux).toBe(true)
  })
})
