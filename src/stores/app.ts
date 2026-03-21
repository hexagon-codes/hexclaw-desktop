import { ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DefineSetupStoreOptions,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
} from 'pinia'
import { checkHealth } from '@/api/client'

const setup = () => {
  const sidecarReady = ref(false)
  const sidebarCollapsed = ref(false)
  const detailPanelOpen = ref(false)

  let healthTimer: ReturnType<typeof setInterval> | null = null

  /** 检查 hexclaw 后端连接状态 */
  async function checkConnection() {
    sidecarReady.value = await checkHealth()
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

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleDetailPanel() {
    detailPanelOpen.value = !detailPanelOpen.value
  }

  return {
    sidecarReady,
    sidebarCollapsed,
    detailPanelOpen,
    checkConnection,
    startHealthCheck,
    stopHealthCheck,
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
