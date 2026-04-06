import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { logger } from '@/utils/logger'
import type {
  DefineSetupStoreOptions,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
} from 'pinia'
import { checkHealth } from '@/api/client'

type SidecarStatus = 'running' | 'stopped' | 'starting'

const setup = () => {
  const sidecarReady = ref(false)
  const sidecarStatus = ref<SidecarStatus>('stopped')
  const sidebarCollapsed = ref(false)
  const detailPanelOpen = ref(false)

  const isRestarting = computed(() => sidecarStatus.value === 'starting')

  let healthTimer: ReturnType<typeof setInterval> | null = null
  let restartPromise: Promise<boolean> | null = null

  /** 检查 hexclaw 后端连接状态 */
  async function checkConnection() {
    const ok = await checkHealth()
    sidecarReady.value = ok
    if (!isRestarting.value) {
      sidecarStatus.value = ok ? 'running' : 'stopped'
    }
  }

  /** 启动健康检查轮询 */
  function startHealthCheck() {
    checkConnection()
    healthTimer = setInterval(checkConnection, 5000)
  }

  /** 停止健康检查轮询 */
  function stopHealthCheck() {
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
  }

  /**
   * 重启 sidecar 引擎，状态切换为：starting(黄) → running/stopped
   * 返回 true 表示重启成功
   */
  function restartSidecar(): Promise<boolean> {
    if (restartPromise) return restartPromise

    sidecarStatus.value = 'starting'
    sidecarReady.value = false

    restartPromise = (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke<string>('restart_sidecar')

        // Tauri 端已做 15s 健康检查轮询，这里带重试兜底瞬时波动
        let ok = false
        for (let i = 0; i < 3; i++) {
          ok = await checkHealth()
          if (ok) break
          await new Promise(r => setTimeout(r, 1000))
        }
        sidecarStatus.value = ok ? 'running' : 'stopped'
        sidecarReady.value = ok
        return ok
      } catch (e) {
        logger.error('[AppStore] restart sidecar failed:', e)
        sidecarStatus.value = 'stopped'
        sidecarReady.value = false
        return false
      } finally {
        restartPromise = null
      }
    })()

    return restartPromise
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleDetailPanel() {
    detailPanelOpen.value = !detailPanelOpen.value
  }

  return {
    sidecarReady,
    sidecarStatus,
    isRestarting,
    sidebarCollapsed,
    detailPanelOpen,
    checkConnection,
    startHealthCheck,
    stopHealthCheck,
    restartSidecar,
    toggleSidebar,
    toggleDetailPanel,
  }
}

type AppStoreSetup = ReturnType<typeof setup>
type AppStoreOptions = DefineSetupStoreOptions<
  'app',
  _ExtractStateFromSetupStore<AppStoreSetup>,
  _ExtractGettersFromSetupStore<AppStoreSetup>,
  _ExtractActionsFromSetupStore<AppStoreSetup>
>

export const useAppStore = defineStore('app', setup, {
  persist: {
    pick: ['sidebarCollapsed', 'detailPanelOpen'],
  },
} as AppStoreOptions)
