import { ref } from 'vue'

export interface AutoUpdateCheckResult {
  status: 'available' | 'up-to-date' | 'error'
  version?: string
  error?: string
}

export interface AutoUpdateInstallResult {
  status: 'installed' | 'no-update' | 'error'
  error?: string
}

const updateAvailable = ref(false)
const updateVersion = ref('')
const checking = ref(false)
const downloading = ref(false)
const checkError = ref('')
const lastCheckedAt = ref('')

function normalizeError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return '检查更新失败'
}

export function useAutoUpdate() {
  async function checkForUpdate(): Promise<AutoUpdateCheckResult> {
    if (checking.value) {
      return updateAvailable.value
        ? { status: 'available', version: updateVersion.value }
        : { status: 'up-to-date' }
    }

    checking.value = true
    checkError.value = ''

    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      lastCheckedAt.value = new Date().toISOString()

      if (update) {
        updateAvailable.value = true
        updateVersion.value = update.version
        return { status: 'available', version: update.version }
      }

      updateAvailable.value = false
      updateVersion.value = ''
      return { status: 'up-to-date' }
    } catch (error) {
      const message = normalizeError(error)
      checkError.value = message
      console.error('检查更新失败:', error)
      return { status: 'error', error: message }
    } finally {
      checking.value = false
    }
  }

  async function installUpdate(): Promise<AutoUpdateInstallResult> {
    if (downloading.value) {
      return { status: 'no-update' }
    }

    downloading.value = true
    checkError.value = ''

    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) {
        updateAvailable.value = false
        updateVersion.value = ''
        lastCheckedAt.value = new Date().toISOString()
        return { status: 'no-update' }
      }

      await update.downloadAndInstall()
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
      return { status: 'installed' }
    } catch (error) {
      const message = normalizeError(error).replace(/^检查更新失败/u, '安装更新失败')
      checkError.value = message
      console.error('安装更新失败:', error)
      return { status: 'error', error: message }
    } finally {
      downloading.value = false
    }
  }

  return {
    updateAvailable,
    updateVersion,
    checking,
    downloading,
    checkError,
    lastCheckedAt,
    checkForUpdate,
    installUpdate,
  }
}
