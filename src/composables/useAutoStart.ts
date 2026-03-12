import { ref } from 'vue'

const autoStartEnabled = ref(false)

export function useAutoStart() {
  async function getAutoStartStatus() {
    try {
      const { isEnabled } = await import('@tauri-apps/plugin-autostart')
      autoStartEnabled.value = await isEnabled()
    } catch {
      // 插件不可用时忽略
    }
  }

  async function toggleAutoStart(enable: boolean) {
    try {
      if (enable) {
        const { enable: enableAutoStart } = await import('@tauri-apps/plugin-autostart')
        await enableAutoStart()
      } else {
        const { disable } = await import('@tauri-apps/plugin-autostart')
        await disable()
      }
      autoStartEnabled.value = enable
    } catch (e) {
      console.error('切换开机自启失败:', e)
    }
  }

  return {
    autoStartEnabled,
    getAutoStartStatus,
    toggleAutoStart,
  }
}
