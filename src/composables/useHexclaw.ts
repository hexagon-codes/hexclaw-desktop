import { ref, onMounted, onUnmounted } from 'vue'
import { checkHealth } from '@/api/client'

/** hexclaw 后端连接状态管理 */
export function useHexclaw() {
  const connected = ref(false)
  const checking = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null
  let retryCount = 0
  let currentInterval = 5000

  async function check() {
    checking.value = true
    try {
      connected.value = await checkHealth()
      if (connected.value) {
        retryCount = 0
        // 恢复正常轮询间隔
        if (currentInterval > 5000) {
          currentInterval = 5000
          stopMonitor()
          timer = setInterval(check, currentInterval)
        }
      } else {
        retryCount++
        // 连续失败 ≥6 次后逐步降低轮询频率，指数退避到 30s 上限
        // （bug 2026-06-22 E：原 `=== 6` 只触发一次，30s 上限是死代码）
        if (retryCount >= 6) {
          const next = Math.min(currentInterval * 2, 30000)
          if (next !== currentInterval) {
            currentInterval = next
            stopMonitor()
            timer = setInterval(check, currentInterval)
          }
        }
      }
    } finally {
      checking.value = false
    }
  }

  function startMonitor(intervalMs = 5000) {
    stopMonitor()
    currentInterval = intervalMs
    retryCount = 0
    check()
    timer = setInterval(check, currentInterval)
  }

  function stopMonitor() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  onMounted(() => startMonitor())
  onUnmounted(() => stopMonitor())

  return { connected, checking, check, startMonitor, stopMonitor }
}
