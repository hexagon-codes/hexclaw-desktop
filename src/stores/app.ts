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

const STARTUP_HEALTH_RETRY_DELAY_MS = 1000
const STARTUP_HEALTH_RETRY_COUNT = 15
const STEADY_HEALTH_CHECK_INTERVAL_MS = 5000

const setup = () => {
  const sidecarReady = ref(false)
  const sidecarStatus = ref<SidecarStatus>('stopped')
  const sidebarCollapsed = ref(false)
  const detailPanelOpen = ref(false)

  const isRestarting = computed(() => sidecarStatus.value === 'starting')

  let healthTimer: ReturnType<typeof setInterval> | null = null
  let startupHealthRetryTimer: ReturnType<typeof setTimeout> | null = null
  let restartPromise: Promise<boolean> | null = null

  /** Sidecar 健康观察已确认就绪时同步运行状态。 */
  function markSidecarReady() {
    sidecarReady.value = true
    if (!isRestarting.value) sidecarStatus.value = 'running'
  }

  /** 检查 hexclaw 后端连接状态 */
  async function checkConnection() {
    const ok = await checkHealth()
    if (ok) {
      markSidecarReady()
    } else {
      sidecarReady.value = false
      if (!isRestarting.value) sidecarStatus.value = 'stopped'
    }
  }

  /** 启动期快速恢复健康检查，确认就绪后转为稳定轮询。 */
  async function recoverInitialHealth(remainingRetries: number) {
    try {
      await checkConnection()
    } finally {
      if (sidecarReady.value || remainingRetries === 0) {
        healthTimer = setInterval(checkConnection, STEADY_HEALTH_CHECK_INTERVAL_MS)
        return
      }

      startupHealthRetryTimer = setTimeout(() => {
        void recoverInitialHealth(remainingRetries - 1)
      }, STARTUP_HEALTH_RETRY_DELAY_MS)
    }
  }

  /** 启动健康检查轮询 */
  function startHealthCheck() {
    stopHealthCheck()
    void recoverInitialHealth(STARTUP_HEALTH_RETRY_COUNT)
  }

  /** 停止健康检查轮询 */
  function stopHealthCheck() {
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
    if (startupHealthRetryTimer) {
      clearTimeout(startupHealthRetryTimer)
      startupHealthRetryTimer = null
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

  function setDetailPanelOpen(open: boolean) {
    detailPanelOpen.value = open
  }

  return {
    sidecarReady,
    sidecarStatus,
    isRestarting,
    sidebarCollapsed,
    detailPanelOpen,
    markSidecarReady,
    checkConnection,
    startHealthCheck,
    stopHealthCheck,
    restartSidecar,
    toggleSidebar,
    toggleDetailPanel,
    setDetailPanelOpen,
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
