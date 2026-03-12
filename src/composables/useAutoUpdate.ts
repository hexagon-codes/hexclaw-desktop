import { ref } from 'vue'

const updateAvailable = ref(false)
const updateVersion = ref('')
const checking = ref(false)
const downloading = ref(false)

export function useAutoUpdate() {
  async function checkForUpdate() {
    checking.value = true
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        updateAvailable.value = true
        updateVersion.value = update.version
      }
    } catch (e) {
      console.error('检查更新失败:', e)
    } finally {
      checking.value = false
    }
  }

  async function installUpdate() {
    downloading.value = true
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      }
    } catch (e) {
      console.error('安装更新失败:', e)
    } finally {
      downloading.value = false
    }
  }

  return {
    updateAvailable,
    updateVersion,
    checking,
    downloading,
    checkForUpdate,
    installUpdate,
  }
}
