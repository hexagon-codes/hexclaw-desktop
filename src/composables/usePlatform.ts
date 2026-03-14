import { ref } from 'vue'

export type Platform = 'macos' | 'windows' | 'linux'

const platform = ref<Platform>(detectPlatform())

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac') || ua.includes('darwin')) return 'macos'
  if (ua.includes('win')) return 'windows'
  return 'linux'
}

export function usePlatform() {
  const isMac = platform.value === 'macos'
  const isWindows = platform.value === 'windows'
  const isLinux = platform.value === 'linux'

  return {
    platform,
    isMac,
    isWindows,
    isLinux,
  }
}
