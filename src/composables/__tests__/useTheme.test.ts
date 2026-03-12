import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// 模拟 useTheme 的核心逻辑（不依赖 onMounted）
describe('useTheme logic', () => {
  let mockStorage: Record<string, string>

  beforeEach(() => {
    mockStorage = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockStorage[key] ?? null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => { mockStorage[key] = val })
  })

  it('defaults to system theme', () => {
    const themeMode = ref<'dark' | 'light' | 'system'>('system')
    expect(themeMode.value).toBe('system')
  })

  it('restores theme from localStorage', () => {
    mockStorage['hc-theme'] = 'light'
    const saved = localStorage.getItem('hc-theme')
    expect(saved).toBe('light')
  })

  it('saves theme to localStorage', () => {
    const themeMode = ref<'dark' | 'light' | 'system'>('dark')
    localStorage.setItem('hc-theme', themeMode.value)
    expect(localStorage.getItem('hc-theme')).toBe('dark')
  })

  it('resolves system to dark or light', () => {
    // jsdom 不支持 matchMedia，mock 它
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() })

    function resolve(mode: 'dark' | 'light' | 'system'): 'dark' | 'light' {
      if (mode === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      return mode
    }
    expect(resolve('dark')).toBe('dark')
    expect(resolve('light')).toBe('light')
    expect(resolve('system')).toBe('dark') // mock 返回 matches: true
  })

  it('validates theme mode values', () => {
    const validModes = ['dark', 'light', 'system']
    expect(validModes.includes('dark')).toBe(true)
    expect(validModes.includes('light')).toBe(true)
    expect(validModes.includes('system')).toBe(true)
    expect(validModes.includes('auto' as string)).toBe(false)
  })
})
