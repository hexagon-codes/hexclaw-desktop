import { ref, watch, onMounted } from 'vue'

export type ThemeMode = 'dark' | 'light' | 'system'

const themeMode = ref<ThemeMode>('system')
const resolvedTheme = ref<'dark' | 'light'>('dark')

let mediaQuery: MediaQueryList | null = null

function getSystemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: 'dark' | 'light') {
  resolvedTheme.value = theme
  document.documentElement.setAttribute('data-theme', theme)
}

function resolve(mode: ThemeMode): 'dark' | 'light' {
  return mode === 'system' ? getSystemTheme() : mode
}

export function useTheme() {
  onMounted(() => {
    // 从 localStorage 恢复
    const saved = localStorage.getItem('hc-theme') as ThemeMode | null
    if (saved && ['dark', 'light', 'system'].includes(saved)) {
      themeMode.value = saved
    }

    applyTheme(resolve(themeMode.value))

    // 监听系统主题变化
    if (!mediaQuery) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', () => {
        if (themeMode.value === 'system') {
          applyTheme(getSystemTheme())
        }
      })
    }
  })

  watch(themeMode, (mode) => {
    localStorage.setItem('hc-theme', mode)
    applyTheme(resolve(mode))
  })

  function setTheme(mode: ThemeMode) {
    themeMode.value = mode
  }

  return {
    themeMode,
    resolvedTheme,
    setTheme,
  }
}
