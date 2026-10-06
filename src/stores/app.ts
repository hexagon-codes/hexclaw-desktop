import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { logger } from '@/utils/logger'
import type {
  DefineSetupStoreOptions,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
} from 'pinia'
import { getVersion } from '@/api/system'
import { checkHealth } from '@/api/client'
import { backendContext, backendScopeKey, assertBackendActive } from '@/services/backend-context'

type SidecarStatus = 'running' | 'stopped' | 'starting'

const STARTUP_HEALTH_RETRY_DELAY_MS = 1000
const STARTUP_HEALTH_RETRY_COUNT = 15
const STEADY_HEALTH_CHECK_INTERVAL_MS = 5000

interface ServiceRestart {
  scope: string
  controller: AbortController
  promise: Promise<boolean>
}

const setup = () => {
  const sidecarReady = ref(false)
  const backendVersion = ref('')
  const sidecarStatus = ref<SidecarStatus>('stopped')
  const sidebarCollapsed = ref(false)
  const detailPanelOpen = ref(false)

  const isRestarting = computed(() => sidecarStatus.value === 'starting')

  let healthTimer: ReturnType<typeof setInterval> | null = null
  let startupHealthRetryTimer: ReturnType<typeof setTimeout> | null = null
  let healthCheckGeneration = 0
  let healthCheckActive = false
  let serviceRestart: ServiceRestart | null = null

  function isCurrentScope(scope: string) {
    try {
      assertBackendActive(scope)
      return true
    } catch {
      return false
    }
  }

  /** Sidecar 健康观察已确认就绪时同步运行状态。 */
  function markSidecarReady() {
    if (backendContext.value?.kind === 'remote' || isRestarting.value) return
    sidecarReady.value = true
    sidecarStatus.value = 'running'
  }

  /** 检查 hexclaw 后端连接状态 */
  async function checkConnection() {
    if (isRestarting.value) return
    const scope = backendScopeKey()
    const generation = healthCheckGeneration
    const ok = await checkHealth()
    if (generation !== healthCheckGeneration || !isCurrentScope(scope) || isRestarting.value) return
    if (ok) {
      sidecarReady.value = true
      sidecarStatus.value = 'running'
      if (!backendVersion.value) {
        try {
          const version = (await getVersion()).version
          if (generation === healthCheckGeneration && isCurrentScope(scope) && !isRestarting.value) {
            backendVersion.value = version
          }
        } catch { /* 版本单独重查 */ }
      }
    } else {
      sidecarReady.value = false
      backendVersion.value = ''
      sidecarStatus.value = 'stopped'
    }
  }

  /** 启动期快速恢复健康检查，确认就绪后转为稳定轮询。 */
  async function recoverInitialHealth(remainingRetries: number, generation: number) {
    if (generation !== healthCheckGeneration) return
    try {
      await checkConnection()
    } finally {
      // 停止或重新启动后，在途首查不能重新创建旧轮询。
      if (generation !== healthCheckGeneration) return
      if (sidecarReady.value || remainingRetries === 0) {
        healthTimer = setInterval(checkConnection, STEADY_HEALTH_CHECK_INTERVAL_MS)
        return
      }

      startupHealthRetryTimer = setTimeout(() => {
        void recoverInitialHealth(remainingRetries - 1, generation)
      }, STARTUP_HEALTH_RETRY_DELAY_MS)
    }
  }

  /** 启动健康检查轮询 */
  function startHealthCheck() {
    clearHealthCheckTimers()
    healthCheckActive = true
    void recoverInitialHealth(STARTUP_HEALTH_RETRY_COUNT, healthCheckGeneration)
  }

  /** 停止健康检查轮询 */
  function stopHealthCheck() {
    healthCheckActive = false
    clearHealthCheckTimers()
  }

  function clearHealthCheckTimers() {
    healthCheckGeneration++
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
    if (startupHealthRetryTimer) {
      clearTimeout(startupHealthRetryTimer)
      startupHealthRetryTimer = null
    }
  }

  /** 同一后端的生命周期动作共用在途状态，旧作用域不得写回新连接。 */
  function runServiceRestart(operation: (restart: ServiceRestart) => Promise<boolean>): Promise<boolean> {
    const scope = backendScopeKey()
    if (serviceRestart?.scope === scope) return serviceRestart.promise
    if (!isCurrentScope(scope)) return Promise.resolve(false)
    const restart: ServiceRestart = { scope, controller: new AbortController(), promise: Promise.resolve(false) }
    serviceRestart = restart
    clearHealthCheckTimers()
    sidecarStatus.value = 'starting'
    sidecarReady.value = false
    restart.promise = (async () => {
      try {
        const ok = await operation(restart)
        assertRestartActive(restart)
        sidecarStatus.value = ok ? 'running' : 'stopped'
        sidecarReady.value = ok
        backendVersion.value = ''
        return ok
      } catch (e) {
        if (serviceRestart === restart && isCurrentScope(scope)) {
          logger.error('[AppStore] restart service failed:', e)
          sidecarStatus.value = 'stopped'
          sidecarReady.value = false
        }
        return false
      } finally {
        if (serviceRestart === restart) {
          serviceRestart = null
          if (healthCheckActive && isCurrentScope(scope)) startHealthCheck()
        }
      }
    })()
    return restart.promise
  }

  function assertRestartActive(restart: ServiceRestart) {
    assertBackendActive(restart.scope)
    if (serviceRestart !== restart || restart.controller.signal.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError')
    }
  }

  /** 本机服务沿用原生停止、拉起及健康确认流程。 */
  function restartSidecar(): Promise<boolean> {
    return runServiceRestart(async restart => {
      const { invoke } = await import('@tauri-apps/api/core')
      assertRestartActive(restart)
      await invoke<string>('restart_sidecar')
      assertRestartActive(restart)

      // 原生已等待健康，这里保留短暂波动时的现有确认。
      for (let i = 0; i < 3; i++) {
        const ok = await checkHealth()
        assertRestartActive(restart)
        if (ok) return true
        await new Promise(resolve => setTimeout(resolve, 1000))
        assertRestartActive(restart)
      }
      return false
    })
  }

  /** 侧栏统一重启当前服务；云端使用同一认证和连接作用域。 */
  function restartService(): Promise<boolean> {
    if (backendContext.value?.kind !== 'remote') return restartSidecar()
    return runServiceRestart(async restart => {
      const { restartRemoteService } = await import('@/api/service-lifecycle')
      assertRestartActive(restart)
      return restartRemoteService(restart.scope, restart.controller.signal)
    })
  }

  watch(() => backendScopeKey(), () => {
    serviceRestart?.controller.abort()
    serviceRestart = null
    clearHealthCheckTimers()
    sidecarReady.value = false
    sidecarStatus.value = 'stopped'
    backendVersion.value = ''
    if (healthCheckActive) startHealthCheck()
  }, { flush: 'sync' })

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
    backendVersion,
    startHealthCheck,
    stopHealthCheck,
    restartSidecar,
    restartService,
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
