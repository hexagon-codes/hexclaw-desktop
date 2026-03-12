import { ref, onUnmounted } from 'vue'

interface UseWebSocketOptions {
  /** 自动重连间隔 (ms)，0 表示不重连 */
  reconnectInterval?: number
  /** 最大重连次数，0 表示无限 */
  maxRetries?: number
}

/** WebSocket 连接封装 (自动重连 + 状态管理) */
export function useWebSocket<T = unknown>(
  url: string,
  onMessage: (data: T) => void,
  options: UseWebSocketOptions = {},
) {
  const { reconnectInterval = 5000, maxRetries = 0 } = options

  const connected = ref(false)
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let retries = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (ws?.readyState === WebSocket.OPEN) return

    try {
      ws = new WebSocket(url)

      ws.onopen = () => {
        connected.value = true
        error.value = null
        retries = 0
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as T
          onMessage(data)
        } catch {
          console.warn('[WS] 解析消息失败:', event.data)
        }
      }

      ws.onerror = () => {
        error.value = 'WebSocket 连接错误'
      }

      ws.onclose = () => {
        connected.value = false
        ws = null
        error.value = null
        scheduleReconnect()
      }
    } catch (e) {
      error.value = String(e)
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (!reconnectInterval) return
    if (maxRetries > 0 && retries >= maxRetries) return

    reconnectTimer = setTimeout(() => {
      retries++
      connect()
    }, reconnectInterval)
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.onclose = null // 阻止重连
      ws.close()
      ws = null
    }
    connected.value = false
  }

  function send(data: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  onUnmounted(() => disconnect())

  return {
    connected,
    error,
    connect,
    disconnect,
    send,
  }
}
