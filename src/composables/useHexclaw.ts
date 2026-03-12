import { ref, onMounted, onUnmounted } from 'vue'
import { checkHealth } from '@/api/client'

/** hexclaw 后端连接状态管理 */
export function useHexclaw() {
  const connected = ref(false)
  const checking = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null
  let retryCount = 0

  async function check() {
    checking.value = true
    try {
      connected.value = await checkHealth()
      if (connected.value) retryCount = 0
    } finally {
      checking.value = false
    }
  }

  /** 启动连接监控，自适应轮询间隔 */
  function startMonitor(intervalMs = 5000) {
    check()
    timer = setInterval(() => {
      check()
      // 连接失败时加快重试，最多每秒一次
      if (!connected.value) {
        retryCount++
        if (retryCount > 5 && timer) {
          clearInterval(timer)
          timer = setInterval(check, Math.min(intervalMs * 2, 30000))
        }
      }
    }, intervalMs)
  }

  function stopMonitor() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  onMounted(() => startMonitor())
  onUnmounted(() => stopMonitor())

  return {
    connected,
    checking,
    check,
    startMonitor,
    stopMonitor,
  }
}
